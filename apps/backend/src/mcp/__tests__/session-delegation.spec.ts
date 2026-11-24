import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentPromptOptions,
  AgentRuntimeProvider,
} from '../../agent-runtime/agent-runtime.types.js';
import { AgentRuntimeRegistryService } from '../../agent-runtime/agent-runtime-registry.service.js';
import { SessionCompletionNoticesService } from '../../agent-runtime/session-completion-notices.service.js';
import { createTestDb } from '../../database/testing/create-test-db.js';
import * as schema from '../../database/schema/index.js';
import { DesktopWorkspaceService } from '../../desktop-workspace/desktop-workspace.service.js';
import { DesktopSessionDelegates } from '../../desktop-workspace/desktop-session-delegates.js';
import { DesktopWorkspaceActivityService } from '../../desktop-workspace/desktop-workspace-activity.service.js';
import type { ClaudeHooksService } from '../../claude-hooks/claude-hooks.service.js';
import { NavigationEventsService } from '../../navigation/navigation-events.service.js';
import { SessionsService } from '../../sessions/sessions.service.js';
import type { TasksService } from '../../tasks/tasks.service.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { SessionEventSubscriptions } from '../session-event-subscriptions.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { McpServerFactory } from '../transport/mcp-server.factory.js';
import { splitSessionAgentPrompt } from '../../sessions/session-agent-message.js';

async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 39) throw error;
      await delay(25);
    }
  }
}

describe('cross-harness delegation through MCP', () => {
  async function fixture() {
    const { db, sqlite } = createTestDb();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Delegation project' })
      .returning()
      .get();
    const repo = db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'Repo', path: tmpdir() })
      .returning()
      .get();
    const task = db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'Delegation task',
        path: tmpdir(),
        taskState: 'ready',
        linkStatus: 'linked',
      })
      .returning()
      .get();
    const root = db
      .insert(schema.sessions)
      .values({
        repoId: repo.id,
        workspaceId: task.id,
        branchName: 'main',
        worktreePath: task.path,
        name: 'Coordinator',
        activeAgentProvider: 'claude',
      })
      .returning()
      .get();
    const navigation = new NavigationEventsService();
    const sessions = new SessionsService(
      db,
      {} as never,
      {} as never,
      { cleanupSession: async () => undefined },
      {
        findOne: async () => ({ defaultAgentProvider: 'claude' }),
        getInitialAgentProvider: () => 'claude',
      } as never,
      navigation,
    );
    const runtime = Object.assign(new EventEmitter(), {
      info: {
        id: 'codex',
        displayName: 'Codex',
        capabilities: { subagents: true },
      },
      getModelCatalog: async () => ({
        models: [
          {
            id: 'worker',
            displayName: 'Worker',
            reasoningEfforts: ['low', 'high'],
          },
        ],
        providerDefaultModelId: 'worker',
        supportsModelSelection: true,
        reasoningEfforts: ['low', 'high'],
      }),
      setReasoningEffort: jest.fn(),
      interrupt: jest.fn(async (_id: number) => undefined),
      getRuntimeState: jest.fn(async (_id: number) => ({
        sessionState: 'idle', runPhase: 'idle', pendingPrompts: [], backgroundWork: [] as readonly unknown[],
      })),
      getHistory: jest.fn(async () => [
        { id: 'brief', kind: 'user', content: 'Review', timestamp: new Date().toISOString() },
        { id: 'final', kind: 'assistant', assistantPhase: 'final', content: '**Reviewed.**', timestamp: new Date().toISOString() },
      ]),
      submitPrompt: jest.fn(
        async (
          _id: number,
          _prompt: string,
          _title?: string,
          _images?: unknown,
          options?: AgentPromptOptions,
        ) => {
          options?.onAccepted?.('running');
        },
      ),
    });
    const parentRuntime = Object.assign(new EventEmitter(), {
      info: { id: 'claude', displayName: 'Claude' },
      getRuntimeState: jest.fn(async (): Promise<{ sessionState: string; runPhase: string; planMode?: boolean }> =>
        ({ sessionState: 'idle', runPhase: 'idle' })),
      submitPrompt: jest.fn(async (
        _id: number,
        _prompt: string,
        _title?: string,
        _images?: unknown,
        options?: AgentPromptOptions,
      ) => { options?.onAccepted?.('running'); }),
    });
    const agentRuntime = new AgentRuntimeRegistryService([
      runtime as unknown as AgentRuntimeProvider,
      parentRuntime as unknown as AgentRuntimeProvider,
    ]);
    let notices: SessionCompletionNoticesService | undefined;
    const tasks = {
      record: async () => task,
      repo: async () => repo,
    } as unknown as TasksService;
    const hooks = Object.assign(new EventEmitter(), {
      getActivity: () => ({ activityStatus: 'idle', actionKind: null, actionLabel: null, backgroundActive: false }),
    }) as unknown as ClaudeHooksService;
    const activity = new DesktopWorkspaceActivityService(agentRuntime, hooks, navigation, sessions);
    activity.onModuleInit();
    const delegates = new DesktopSessionDelegates(db, activity, sessions, agentRuntime);
    const workspace = new DesktopWorkspaceService(
      db,
      { assertProjectIsActive: async () => undefined } as never,
      {} as never,
      tasks,
      sessions,
      {} as never,
      {} as never,
      activity,
      delegates,
    );
    const tokens = new McpAgentTokenService(db);
    const services = {
      sessions,
      tasks,
      agentRuntime,
      sessionEvents: new SessionEventSubscriptions(),
    } as unknown as McpToolServices;
    const factory = new McpServerFactory(
      new ToolRegistryService(
        services,
        new DeltaCursorStore(),
        new DeepLinkBuilder(),
        new AgentHumanChannelService(),
        tokens,
        new McpConnectionRegistryService(),
        navigation,
      ),
    );
    const closeConnections: (() => Promise<void>)[] = [];
    async function connect(sessionId?: number) {
      const token =
        sessionId === undefined
          ? undefined
          : await tokens.ensureToken(sessionId);
      const server = factory.create();
      const client = new Client({ name: 'delegation-test', version: '1' });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const send = clientTransport.send.bind(clientTransport);
      clientTransport.send = (message, options) =>
        send(
          message,
          token
            ? {
                ...options,
                authInfo: { token, clientId: 'delegation-test', scopes: [] },
              }
            : options,
        );
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      closeConnections.push(async () => {
        await client.close();
        await server.close();
      });
      return async (name: string, args: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args })).structuredContent;
    }
    return {
      db,
      root,
      task,
      sessions,
      runtime,
      parentRuntime,
      workspace,
      delegates,
      connect,
      startNotices() {
        notices?.onModuleDestroy();
        notices = new SessionCompletionNoticesService(agentRuntime, sessions);
        notices.onApplicationBootstrap();
      },
      async close() {
        notices?.onModuleDestroy();
        await Promise.all(closeConnections.map((close) => close()));
        activity.onModuleDestroy();
        navigation.onModuleDestroy();
        sqlite.close();
      },
    };
  }

  it('claims one named cross-harness turn across concurrent retries and exposes the child in the desktop group', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      expect(
        await call('list_agent_harnesses', { provider: 'codex' }),
      ).toMatchObject({
        data: { models: [{ id: 'worker', reasoningEfforts: ['low', 'high'] }] },
      });
      const args = {
        requestId: 'review-race',
        provider: 'codex',
        model: 'worker',
        reasoningEffort: 'high',
        name: 'Review the race',
        prompt: 'Review only the queue; return focused findings.',
      };
      const results = await Promise.all([
        call('create_session', args),
        call('create_session', args),
      ]);
      const children = await f.workspace.listSessions(f.task.id, {
        parentSessionId: String(f.root.id),
        childOrder: 'nested',
      });
      expect(children.items).toMatchObject([
        { parentSessionId: f.root.id, provider: 'codex', name: args.name },
      ]);
      const childId = children.items[0].id;
      for (const result of results)
        expect(result).toMatchObject({
          data: {
            sessionId: childId,
            parentSessionId: f.root.id,
            delegatedBySessionId: f.root.id,
            model: 'worker',
            reasoningEffort: 'high',
          },
        });
      const roots = await f.workspace.listSessions(f.task.id, {
        parentSessionId: 'root',
      });
      expect(roots.items).toMatchObject([{ id: f.root.id, childCount: 1 }]);
      expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(1);
      expect(f.runtime.submitPrompt).toHaveBeenCalledWith(
        childId,
        expect.stringContaining(`[Elevenex delegation from session #${f.root.id}]`),
        args.prompt,
        undefined,
        expect.objectContaining({ queue: true, waitForCompletion: false }),
      );
      expect(splitSessionAgentPrompt(f.runtime.submitPrompt.mock.calls[0][1])).toMatchObject({
        text: args.prompt,
        sender: { purpose: 'assignment', session: { sessionId: f.root.id, taskId: f.task.id, selection: { provider: 'claude' } } },
      });
      expect(await call('create_session', args)).toMatchObject({
        data: { sessionId: childId, promptStatus: 'accepted' },
      });
      expect(
        await call('create_session', { ...args, prompt: 'Different work' }),
      ).toMatchObject({
        error: { code: 'session_request_conflict' },
      });
      expect((await f.sessions.findOne(childId)).agentSelection).toEqual({
        provider: 'codex',
        model: 'worker',
        reasoningEffort: 'high',
      });
    } finally {
      await f.close();
    }
  });

  it('retains the actual delegator when the sidebar group is already two levels deep', async () => {
    const f = await fixture();
    try {
      const parent = await f.connect(f.root.id);
      await parent('create_session', { name: 'First child' });
      const [first] = (
        await f.workspace.listSessions(f.task.id, {
          parentSessionId: String(f.root.id),
        })
      ).items;
      const child = await f.connect(first.id);
      expect(
        await child('create_session', { name: 'Second child' }),
      ).toMatchObject({
        data: { parentSessionId: f.root.id, delegatedBySessionId: first.id },
      });
      expect(
        await child('create_session', {
          name: 'Standalone',
          placement: 'task',
        }),
      ).toMatchObject({
        data: { parentSessionId: null, delegatedBySessionId: null },
      });
      const outside = await f.connect();
      expect(
        await outside('create_session', {
          name: 'External',
          taskId: f.task.id,
        }),
      ).toMatchObject({
        data: { parentSessionId: null },
      });
      await f.workspace.moveSession(f.task.id, first.id, null);
      const roots = await f.workspace.listSessions(f.task.id, {
        parentSessionId: 'root',
      });
      expect(roots.items.map((row) => row.name)).toEqual([
        'Coordinator',
        'First child',
        'Standalone',
        'External',
      ]);

      f.db
        .delete(schema.sessions)
        .where(eq(schema.sessions.id, first.id))
        .run();
      const [remaining] = (
        await f.workspace.listSessions(f.task.id, {
          parentSessionId: String(f.root.id),
        })
      ).items;
      expect(remaining.name).toBe('Second child');
      expect(
        (await f.sessions.findOne(remaining.id)).delegatedBySessionId,
      ).toBeNull();
    } finally {
      await f.close();
    }
  });

  it('persists an exact reply handoff once and releases the live wait', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      f.startNotices();
      const call = await f.connect(f.root.id);
      await call('create_session', { requestId: 'review', provider: 'codex', model: 'worker', prompt: 'Review retries', completion: 'notify' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      const history = await f.runtime.getHistory();
      let releaseHistory = () => {};
      const historyReady = new Promise<void>(resolve => { releaseHistory = resolve; });
      f.runtime.getHistory.mockImplementationOnce(async () => { await historyReady; return history; });
      const input = { sessionId: child.id, includeReply: true, timeoutMs: 500 };
      const result = { data: { session: { sessionId: child.id, taskId: f.task.id }, event: 'completed', reply: { id: 'final', text: '**Reviewed.**' } } };
      const wait = call('await_session_event', input);
      try {
        await eventually(() => expect(f.runtime.getHistory).toHaveBeenCalledTimes(2));
        await f.sessions.markCompletionUnreviewed(child.id);
        await eventually(() => expect(f.sessions.delegationHandoffs.outbox.status(child.id, f.root.id))
          .toMatchObject({ state: 'ready' }));
        expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
      } finally {
        releaseHistory();
      }
      expect(await wait).toMatchObject(result);
      expect(await call('await_session_event', input)).toMatchObject(result);
      expect(f.sessions.delegationHandoffs.waiting(f.root.id, child.id)).toBe(false);
      expect(f.db.select().from(schema.sessionReplyReturns).all()).toMatchObject([
        { sessionId: child.id, recipientId: f.root.id, itemId: 'final' },
      ]);
      expect(f.db.select().from(schema.sessionCompletionNotices).all()).toMatchObject([
        { sessionId: child.id, recipientId: f.root.id, state: 'consumed' },
      ]);
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('wakes an idle parent once for ready siblings after their background work settles', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      f.parentRuntime.getRuntimeState.mockResolvedValue({ sessionState: 'running', runPhase: 'running' });
      const call = await f.connect(f.root.id);
      f.startNotices();
      for (const requestId of ['tests', 'review'])
        expect(await call('create_session', { requestId, provider: 'codex', prompt: requestId, completion: 'notify' }))
          .toMatchObject({ data: { completion: 'notify', accepted: true } });
      const { items: [tests, review] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      let testsRunning = true;
      f.runtime.getRuntimeState.mockImplementation(async sessionId => ({
        sessionState: 'idle', runPhase: 'idle', pendingPrompts: [],
        backgroundWork: sessionId === tests.id && testsRunning ? [{ id: 'task:test' }] : [],
      }));
      await f.sessions.markCompletionUnreviewed(tests.id);
      await f.sessions.markCompletionUnreviewed(review.id);
      const states = () => f.db.select().from(schema.sessionCompletionNotices).all().map(row => row.state);
      await eventually(() => expect(states()).toEqual(['waiting', 'ready']));
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
      testsRunning = false;
      f.runtime.emit('event', { type: 'background_work', payload: { sessionId: tests.id } });
      await eventually(() => expect(states()).toEqual(['ready', 'ready']));
      f.parentRuntime.getRuntimeState.mockResolvedValue({ sessionState: 'idle', runPhase: 'idle' });
      f.parentRuntime.emit('event', { type: 'run_state', payload: { sessionId: f.root.id, sessionState: 'idle', runPhase: 'idle' } });
      await eventually(() => expect(states()).toEqual(['accepted', 'accepted']));
      expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
      const [parentId, notice] = f.parentRuntime.submitPrompt.mock.calls[0];
      expect(parentId).toBe(f.root.id);
      expect(notice).toContain(`Session #${tests.id}: completed.`);
      expect(notice).toContain(`Session #${review.id}: completed.`);
      expect(f.runtime.getHistory).not.toHaveBeenCalled();
      expect(await call('session_status', { sessionId: review.id })).toMatchObject({
        data: { completionNotice: { state: 'accepted', outcome: 'completed' } },
      });
      f.startNotices();
      await delay(100);
      expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('recovers a persisted child completion and keeps an interrupted send unconfirmed', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      for (const requestId of ['recover', 'ambiguous'])
        await call('create_session', { requestId, provider: 'codex', prompt: requestId, completion: 'notify' });
      const { items: [recover, ambiguous] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.markCompletionUnreviewed(recover.id);
      await f.sessions.markCompletionUnreviewed(ambiguous.id);
      f.db.update(schema.sessionCompletionNotices).set({ state: 'dispatching', outcome: 'completed' })
        .where(eq(schema.sessionCompletionNotices.sessionId, ambiguous.id)).run();
      await f.sessions.updatePlanMode(f.root.id, true);
      f.startNotices();
      const states = () => f.db.select().from(schema.sessionCompletionNotices).all().map(row => row.state);
      await eventually(() => expect(states()).toEqual(['ready', 'unconfirmed']));
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
      f.parentRuntime.getRuntimeState.mockResolvedValue({ sessionState: 'idle', runPhase: 'idle', planMode: true });
      await f.sessions.updatePlanMode(f.root.id, false);
      await eventually(() => expect(f.parentRuntime.getRuntimeState).toHaveBeenCalled());
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
      f.parentRuntime.getRuntimeState.mockResolvedValue({ sessionState: 'idle', runPhase: 'idle', planMode: false });
      f.parentRuntime.emit('event', { type: 'run_state', payload: { sessionId: f.root.id, sessionState: 'idle', runPhase: 'idle', planMode: false } });
      await eventually(() => expect(states()).toEqual(['accepted', 'unconfirmed']));
      expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain(`Session #${recover.id}: completed.`);
    } finally {
      await f.close();
    }
  });

  it('reports failed launches and suppresses notices when the delegator stops the child', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      f.startNotices();
      const call = await f.connect(f.root.id);
      expect(await call('create_session', { requestId: 'outside', placement: 'task', provider: 'codex', prompt: 'Review', completion: 'notify' }))
        .toMatchObject({ error: { code: 'invalid_session_completion' } });
      await call('create_session', { requestId: 'cancel', provider: 'codex', prompt: 'Review', completion: 'notify' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await call('interrupt_session', { sessionId: child.id });
      f.runtime.submitPrompt.mockRejectedValueOnce(new Error('Harness unavailable'));
      expect(await call('create_session', { requestId: 'failure', provider: 'codex', prompt: 'Review', completion: 'notify' }))
        .toMatchObject({ error: { code: 'session_launch_failed' } });
      await eventually(() => expect(f.db.select().from(schema.sessionCompletionNotices).all()).toMatchObject([
        { state: 'consumed' }, { state: 'accepted', outcome: 'failed' },
      ]));
      expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).not.toContain(`Session #${child.id}:`);
    } finally {
      await f.close();
    }
  });

  it('projects a waiting delegate into the parent feed and outline with its exact archive consent target', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      await call('create_session', { requestId: 'review', provider: 'codex', model: 'worker', prompt: 'Review retries' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      f.runtime.emit('event', { type: 'run_state', payload: {
        sessionId: child.id, runPhase: 'waiting', pendingPermissionRequest: { description: 'Approve the test command' },
      } });
      const parent = await f.sessions.findOne(f.root.id);
      expect(f.delegates.read(parent, false)).toMatchObject({
        sessions: [{ session: { sessionId: child.id, taskId: f.task.id, selection: { provider: 'codex', model: 'worker' } },
          status: 'waiting', detail: 'Approve the test command' }],
        totalSessionsRunning: 1,
      });
      const outline = await f.workspace.listSessions(f.task.id, { parentSessionId: 'root' });
      expect(outline.items).toMatchObject([{ childSummary: { status: 'attention', count: 1 }, activeChildAgents: [child.id] }]);
      expect(await f.delegates.stopChildren(f.task.id, f.root.id, [child.id + 1])).toBe(false);
      expect(f.runtime.interrupt).not.toHaveBeenCalled();
      expect(await f.delegates.stopChildren(f.task.id, f.root.id, [child.id])).toBe(true);
      expect(f.runtime.interrupt).toHaveBeenCalledWith(child.id);
      expect(f.runtime.getHistory).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('validates effort and plan mode before launching and never retries a failed first delivery implicitly', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      const args = {
        requestId: 'first',
        provider: 'codex',
        model: 'worker',
        prompt: 'Review changes',
      };
      expect(
        await call('create_session', {
          ...args,
          reasoningEffort: 'unsupported',
        }),
      ).toMatchObject({
        error: { code: 'invalid_agent_selection' },
      });
      await f.sessions.updatePlanMode(f.root.id, true);
      expect(await call('create_session', args)).toMatchObject({
        error: { code: 'delegation_blocked_in_plan_mode' },
      });
      expect(
        (
          await f.workspace.listSessions(f.task.id, {
            parentSessionId: String(f.root.id),
          })
        ).items,
      ).toHaveLength(0);
      await f.sessions.updatePlanMode(f.root.id, false);
      f.runtime.submitPrompt.mockRejectedValueOnce(
        new Error('Harness unavailable'),
      );
      expect(await call('create_session', args)).toMatchObject({
        error: {
          code: 'session_launch_failed',
          details: { sessionId: expect.any(Number) },
        },
      });
      expect(await call('create_session', args)).toMatchObject({
        data: { promptStatus: 'failed', accepted: false },
      });
      expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
});
