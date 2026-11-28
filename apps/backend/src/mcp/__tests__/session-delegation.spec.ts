import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentPromptOptions,
  AgentTranscriptItem,
  AgentRuntimeProvider,
  AgentRuntimeStatePayload,
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
  async function fixture(parentProvider = 'claude') {
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
        activeAgentProvider: parentProvider,
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
      clearPendingPrompts: jest.fn(async (_id: number) => undefined),
      getRuntimeState: jest.fn(async (_id: number) => ({
        sessionState: 'idle', runPhase: 'idle', pendingPrompts: [], backgroundWork: [] as readonly unknown[],
      })),
      getHistory: jest.fn(async (): Promise<AgentTranscriptItem[]> => [
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
      info: {
        id: parentProvider,
        displayName: parentProvider,
        capabilities: { nonInterruptingSteering: parentProvider === 'claude' },
      },
      getRuntimeState: jest.fn(async (): Promise<Omit<AgentRuntimeStatePayload, 'sessionId'>> =>
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
    const buildMention = jest.fn(async (sessionId: number) => ({
      sessionId, title: 'Prior review', provider: 'claude', branch: 'main', status: 'active',
      transcriptExportPath: '/tmp/prior-review.md', contextMarkdown: 'Prior finding.',
    }));
    const services = {
      sessions,
      tasks,
      agentRuntime,
      conversationExport: { buildMention },
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
      buildMention,
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

  it('launches with prior session context and reuses the first delivery on retry', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      const args = {
        provider: 'codex', requestId: 'handoff', prompt: 'Verify the prior finding.',
        mentionSessionIds: [f.root.id, f.root.id],
      };
      expect(await call('create_session', args)).toMatchObject({
        data: { accepted: true, completion: 'notify' },
      });
      expect(await call('create_session', { ...args, mentionSessionIds: [f.root.id] })).toMatchObject({
        data: { promptStatus: 'accepted' },
      });
      expect(f.buildMention.mock.calls).toEqual([[f.root.id]]);
      expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(1);
      expect(f.runtime.submitPrompt.mock.calls[0][1]).toContain('Prior finding.');
    } finally {
      await f.close();
    }
  });

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
          mode: 'standalone',
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
      f.parentRuntime.getRuntimeState.mockResolvedValue({
        sessionState: 'running', runPhase: 'running',
      });
      f.startNotices();
      const call = await f.connect(f.root.id);
      await call('create_session', { requestId: 'review', provider: 'codex', model: 'worker', prompt: 'Review retries', mode: 'async' });
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

  it('wakes an idle parent once for ready siblings after earlier work settles', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      f.parentRuntime.getRuntimeState.mockResolvedValue({
        sessionState: 'running',
        runPhase: 'running',
        pendingPrompts: [{ prompt: 'Earlier user input' }],
      });
      const call = await f.connect(f.root.id);
      f.startNotices();
      for (const requestId of ['tests', 'review'])
        expect(await call('create_session', { requestId, provider: 'codex', prompt: requestId, mode: 'async' }))
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
      expect(notice).toContain('Child reply excerpt:\n**Reviewed.**');
      expect(f.runtime.getHistory).toHaveBeenCalledTimes(2);
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

  it.each(['steered', 'queued', 'unconfirmed'] as const)(
    'delivers a child result to a running parent once when steering is %s',
    async (disposition) => {
      const f = await fixture();
      try {
        await f.sessions.updateStatus(f.root.id, 'active');
        f.parentRuntime.getRuntimeState.mockResolvedValue({
          sessionState: 'running',
          runPhase: 'running',
        });
        f.parentRuntime.submitPrompt.mockImplementationOnce(
          async (_id, _prompt, _title, _images, options) => {
            if (disposition === 'unconfirmed') throw new Error('Transport disconnected');
            options?.onAccepted?.(disposition);
          },
        );
        const call = await f.connect(f.root.id);
        f.startNotices();
        const args = {
          requestId: 'live-result',
          provider: 'codex',
          prompt: 'Review',
        };
        const launched = await call('create_session', args);
        expect(launched).toMatchObject({
          data: { accepted: true, completion: 'notify' },
          nextStep: expect.stringContaining('end your turn when none remains'),
        });
        expect(launched).not.toHaveProperty('data.result');
        const { items: [child] } = await f.workspace.listSessions(f.task.id, {
          parentSessionId: String(f.root.id),
        });
        const sessionId = child.id;
        expect(await call('create_session', args)).toMatchObject({
          data: { sessionId, accepted: true, completion: 'notify' },
        });
        expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(1);
        const fullReply = '**Reviewed.**\n' + 'x'.repeat(8_000);
        const history = await f.runtime.getHistory();
        f.runtime.getHistory.mockResolvedValueOnce([history[0], { ...history[1], content: fullReply }]);
        await f.sessions.markCompletionUnreviewed(sessionId);

        const status = () => f.sessions.delegationHandoffs.outbox.status(sessionId, f.root.id);
        await eventually(() => expect(status()).toMatchObject({
          state: disposition === 'unconfirmed' ? 'unconfirmed' : 'accepted',
          outcome: 'completed',
        }));
        expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
        expect(f.parentRuntime.submitPrompt).toHaveBeenCalledWith(
          f.root.id,
          expect.stringContaining('Child reply excerpt:\n**Reviewed.**'),
          undefined,
          undefined,
          expect.objectContaining({ queue: false, preferSteering: true }),
        );
        const notice = f.parentRuntime.submitPrompt.mock.calls[0][1];
        expect(notice).toContain(`Child reply excerpt:\n${fullReply.slice(0, 8_000)}\n[Reply truncated]`);
        expect(notice).not.toContain(fullReply);
        expect(f.db.select().from(schema.sessionReplyReturns).all()).toEqual(
          disposition === 'unconfirmed' ? [] : [
            expect.objectContaining({ sessionId, recipientId: f.root.id, itemId: 'final' }),
          ],
        );

        const idle = { sessionState: 'idle', runPhase: 'idle' };
        f.parentRuntime.getRuntimeState.mockResolvedValue(idle);
        f.parentRuntime.emit('event', { type: 'run_state', payload: { sessionId: f.root.id, ...idle } });
        await delay(150);
        expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
      } finally {
        await f.close();
      }
    },
  );

  it('returns a blocking launch result and wakes the parent after a timed-out launch', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      f.startNotices();
      const base = { provider: 'codex', prompt: 'Review', mode: 'wait' };
      f.runtime.submitPrompt.mockImplementationOnce(async (childId, _prompt, _title, _images, options) => {
        expect(f.sessions.delegationHandoffs.waiting(f.root.id, childId)).toBe(true);
        await f.sessions.markCompletionUnreviewed(childId);
        await eventually(() => expect(f.sessions.delegationHandoffs.outbox.status(childId, f.root.id))
          .toMatchObject({ state: 'ready' }));
        expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
        options?.onAccepted?.('running');
      });
      expect(await call('create_session', { ...base, requestId: 'quick', timeoutMs: 500 }))
        .toMatchObject({ data: { result: { event: 'completed', reply: { text: '**Reviewed.**' } } } });
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();

      f.runtime.getRuntimeState.mockResolvedValue({
        sessionState: 'running', runPhase: 'running', pendingPrompts: [], backgroundWork: [],
      });
      expect(await call('create_session', { ...base, requestId: 'slow', timeoutMs: 20 }))
        .toMatchObject({ data: { result: { event: 'timeout' } } });
      const { items: [quick, slow] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      f.runtime.getRuntimeState.mockResolvedValue({
        sessionState: 'idle', runPhase: 'idle', pendingPrompts: [], backgroundWork: [],
      });
      await f.sessions.markCompletionUnreviewed(quick.id);
      await f.sessions.markCompletionUnreviewed(slow.id);
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1));
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain(`Session #${slow.id}: completed.`);
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).not.toContain(`Session #${quick.id}: completed.`);
    } finally {
      await f.close();
    }
  });

  it('lets an Antigravity parent collect delegated work without scheduling an interactive turn', async () => {
    const f = await fixture('antigravity');
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      f.startNotices();
      const result = await call('create_session', {
        requestId: 'interactive-parent', provider: 'codex', prompt: 'Review', mode: 'async',
      });
      expect(result).toMatchObject({
        data: { accepted: true, completion: 'wait' },
        nextStep: expect.stringContaining('await_session_event'),
      });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.markCompletionUnreviewed(child.id);
      expect(f.sessions.delegationHandoffs.outbox.status(child.id, f.root.id)).toBeUndefined();
      expect(await call('await_session_event', { sessionId: child.id, includeReply: true })).toMatchObject({
        data: { event: 'completed', reply: { text: '**Reviewed.**' } },
      });
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('wakes a parent once for a blocking decision and still delivers completion', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      f.startNotices();
      const result = await call('create_session', {
        requestId: 'decision', provider: 'codex', prompt: 'Review', role: 'review', mode: 'async',
      });
      expect(result).toMatchObject({ data: { accepted: true } });
      expect(f.runtime.submitPrompt.mock.calls[0][1]).toContain('Act as the review subagent');
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      f.runtime.getRuntimeState.mockResolvedValue({
        sessionState: 'requires_action', runPhase: 'waiting', pendingPrompts: [], backgroundWork: [],
        pendingUserInputRequest: { requestId: 'question-1' },
      } as Awaited<ReturnType<typeof f.runtime.getRuntimeState>>);
      f.runtime.emit('event', { type: 'user_input_request', payload: { sessionId: child.id } });
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1));
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain(`Session #${child.id} needs a decision.`);
      f.startNotices();
      await delay(120);
      expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1);
      f.runtime.getRuntimeState.mockResolvedValue({
        sessionState: 'idle', runPhase: 'idle', pendingPrompts: [], backgroundWork: [],
      });
      await f.sessions.markCompletionUnreviewed(child.id);
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(2));
      expect(f.parentRuntime.submitPrompt.mock.calls[1][1]).toContain(`Session #${child.id}: completed.`);
    } finally {
      await f.close();
    }
  });

  it('suppresses a question wake when the parent collects it during a wait', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      f.startNotices();
      await call('create_session', { requestId: 'question', provider: 'codex', prompt: 'Review', mode: 'async' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      f.runtime.getRuntimeState.mockResolvedValue({
        sessionState: 'running', runPhase: 'running', pendingPrompts: [], backgroundWork: [],
      });
      const wait = call('await_session_event', { sessionId: child.id, includeReply: true, timeoutMs: 500 });
      await eventually(() => expect(f.sessions.delegationHandoffs.waiting(f.root.id, child.id)).toBe(true));
      const waiting = {
        sessionState: 'requires_action', runPhase: 'waiting', pendingPrompts: [], backgroundWork: [],
        pendingPermissionRequest: { requestId: 'permission-1' },
      };
      f.runtime.getRuntimeState.mockResolvedValue(waiting);
      f.runtime.emit('event', { type: 'run_state', payload: { sessionId: child.id, ...waiting } });
      expect(await wait).toMatchObject({ data: { event: 'requires_action' } });
      f.startNotices();
      await delay(200);
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('cancels a direct delegate and descendants while preserving their conversations', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      await call('create_session', { requestId: 'child', provider: 'codex', prompt: 'Review' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      const callChild = await f.connect(child.id);
      await callChild('create_session', { requestId: 'grandchild', provider: 'codex', prompt: 'Verify' });
      const grandchild = f.sessions.delegationHandoffs.children(child.id)[0];
      expect(await call('cancel_session_delegation', { sessionId: grandchild }))
        .toMatchObject({ error: { code: 'not_your_delegate' } });
      expect(await call('cancel_session_delegation', { sessionId: child.id }))
        .toMatchObject({ data: { sessionId: child.id, cancelled: 2 } });
      for (const id of [child.id, grandchild]) {
        expect(f.runtime.interrupt).toHaveBeenCalledWith(id);
        expect(f.runtime.clearPendingPrompts).toHaveBeenCalledWith(id);
        expect((await f.sessions.findOne(id)).status).toBe('active');
      }
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
        await call('create_session', { requestId, provider: 'codex', prompt: requestId, mode: 'async' });
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
      expect(await call('create_session', { requestId: 'outside', folderId: 1, provider: 'codex', prompt: 'Review', mode: 'async' }))
        .toMatchObject({ error: { code: 'invalid_session_completion' } });
      await call('create_session', { requestId: 'cancel', provider: 'codex', prompt: 'Review', mode: 'async' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await call('interrupt_session', { sessionId: child.id });
      f.runtime.submitPrompt.mockRejectedValueOnce(new Error('Harness unavailable'));
      expect(await call('create_session', { requestId: 'failure', provider: 'codex', prompt: 'Review', mode: 'async' }))
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

  it('delivers a new assignment after collecting the original result, without returning an old final', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First review' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.markCompletionUnreviewed(child.id);
      await call('await_session_event', { sessionId: child.id, timeoutMs: 500 });
      f.startNotices();
      await eventually(() => expect(f.sessions.delegationHandoffs.outbox.status(child.id, f.root.id)?.state).toBe('consumed'));
      const history = await f.runtime.getHistory();
      await call('prompt_session', { sessionId: child.id, prompt: 'Now create mockups', requestId: 'mockups' });
      const sent = f.runtime.submitPrompt.mock.calls.at(-1)![1];
      const receipt = splitSessionAgentPrompt(sent).sender!;
      expect(receipt).toMatchObject({ purpose: 'assignment', session: { sessionId: f.root.id } });
      // Recovery sees an idle runtime and the earlier completion, but this new prompt has not run.
      f.startNotices();
      await eventually(() => expect(f.sessions.delegationHandoffs.outbox.status(child.id, f.root.id)?.state).toBe('waiting'));
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
      f.runtime.getHistory.mockResolvedValue([...history,
        { id: 'follow-up', kind: 'user', content: sent, timestamp: new Date().toISOString() },
        { id: 'mockup-result', kind: 'assistant', assistantPhase: 'final', content: 'Five mockups are ready.', timestamp: new Date().toISOString() },
      ]);
      await f.sessions.markCompletionUnreviewed(child.id);
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1));
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain('Five mockups are ready.');
      expect(f.db.select().from(schema.sessionCompletionNotices).all().map(row => row.state)).toEqual(['consumed', 'accepted']);
    } finally { await f.close(); }
  });

  it('keeps queued assignments and their exact results distinct in one completion batch', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await call('prompt_session', { sessionId: child.id, prompt: 'Second', requestId: 'second', mode: 'queue' });
      const [first, second] = f.runtime.submitPrompt.mock.calls.map(row => row[1]);
      const timestamp = new Date().toISOString();
      f.runtime.getHistory.mockResolvedValue([
        { id: 'first', kind: 'user', content: first, timestamp },
        { id: 'first-answer', kind: 'assistant', assistantPhase: 'final', content: 'First result.', timestamp },
        { id: 'second', kind: 'user', content: second, timestamp },
        { id: 'second-answer', kind: 'assistant', assistantPhase: 'final', content: 'Second result.', timestamp },
      ]);
      await f.sessions.markCompletionUnreviewed(child.id);
      f.startNotices();
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1));
      const rows = f.db.select().from(schema.sessionCompletionNotices).all();
      expect(rows.map(row => [row.replyId, row.replyText, row.state])).toEqual([
        ['first-answer', 'First result.', 'accepted'], ['second-answer', 'Second result.', 'accepted'],
      ]);
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain('First result.');
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain('Second result.');
    } finally { await f.close(); }
  });

  it('routes a nested child question to its actual delegator and safely deduplicates retries', async () => {
    const f = await fixture();
    try {
      const rootCall = await f.connect(f.root.id);
      await rootCall('create_session', { provider: 'codex', requestId: 'middle', prompt: 'Coordinate' });
      const { items: [middle] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      const middleCall = await f.connect(middle.id);
      await middleCall('create_session', { provider: 'codex', requestId: 'nested', prompt: 'Design' });
      const nested = (await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) })).items.find(row => row.id !== middle.id)!;
      const childCall = await f.connect(nested.id);
      const retryCall = await f.connect(nested.id);
      const args = { to: 'parent', message: 'Should the card close automatically?', requestId: 'question' };
      const before = f.runtime.submitPrompt.mock.calls.length;
      const results = await Promise.all([childCall('send_session_message', args), retryCall('send_session_message', args)]);
      expect(results).toEqual([expect.objectContaining({ data: expect.objectContaining({ sessionId: middle.id }) }),
        expect.objectContaining({ data: expect.objectContaining({ sessionId: middle.id }) })]);
      expect(await retryCall('send_session_message', args)).toMatchObject({ data: { accepted: true } });
      expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(before + 1);
      const [target, sent] = f.runtime.submitPrompt.mock.calls.at(-1)!;
      expect(target).toBe(middle.id);
      expect(splitSessionAgentPrompt(sent).sender).toMatchObject({ purpose: 'message', session: { sessionId: nested.id } });
      expect(f.db.select().from(schema.sessionCompletionNotices).all()).toHaveLength(2);
      expect(await childCall('send_session_message', { ...args, message: 'Different contents' })).toHaveProperty('error');
      expect(await childCall('send_session_message', { ...args, to: nested.id, requestId: 'self' })).toMatchObject({ error: { code: 'self_target_not_allowed' } });
      expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(before + 1);
    } finally { await f.close(); }
  });

  it('keeps an unconfirmed send durable across recovery and never submits the same request twice', async () => {
    const f = await fixture();
    let release = () => {};
    try {
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      const retry = await f.connect(f.root.id);
      const ready = new Promise<void>(resolve => { release = resolve; });
      f.runtime.submitPrompt.mockImplementationOnce(async (_id, _prompt, _title, _images, options) => {
        await ready;
        options?.onAccepted?.('queued');
      });
      const args = { sessionId: child.id, prompt: 'More work', requestId: 'follow-up' };
      const sending = call('prompt_session', args);
      await eventually(() => expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(2));
      f.startNotices();
      expect(await retry('prompt_session', args)).toMatchObject({ data: {
        accepted: false, status: 'acceptance_pending', deliveryState: 'unconfirmed',
      } });
      release();
      expect(await sending).toMatchObject({ data: { accepted: true, disposition: 'queued' } });
      expect(await retry('prompt_session', args)).toMatchObject({ data: { accepted: true, deliveryState: 'accepted' } });
      expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(2);
    } finally { release(); await f.close(); }
  });

  it('does not start a message without a parent, and does not permit an unrelated completion subscription', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      expect(await call('send_session_message', { to: 'parent', message: 'Question', requestId: 'q' }))
        .toMatchObject({ error: { code: 'no_delegating_session' } });
      await call('create_session', { provider: 'codex', requestId: 'standalone', mode: 'standalone', prompt: 'Independent' });
      const independent = (await f.workspace.listSessions(f.task.id, {})).items.find(row => row.id !== f.root.id)!;
      expect(await call('prompt_session', { sessionId: independent.id, prompt: 'Question', notifyOnCompletion: true }))
        .toMatchObject({ error: { code: 'not_your_delegate' } });
      expect(f.db.select().from(schema.sessionCompletionNotices).all()).toHaveLength(0);
    } finally { await f.close(); }
  });


  it('waits for the new assignment and collects its result without a second automatic wake', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.markCompletionUnreviewed(child.id);
      await call('await_session_event', { sessionId: child.id, timeoutMs: 500 });
      f.startNotices();
      await call('prompt_session', { sessionId: child.id, prompt: 'Follow up', requestId: 'next' });
      expect(await call('await_session_event', { sessionId: child.id, timeoutMs: 25 }))
        .toMatchObject({ data: { event: 'timeout' } });
      const sent = f.runtime.submitPrompt.mock.calls.at(-1)![1];
      const timestamp = new Date().toISOString();
      f.runtime.getHistory.mockResolvedValue([
        { id: 'next', kind: 'user', content: sent, timestamp },
        { id: 'new-result', kind: 'assistant', content: 'New result.', assistantPhase: 'final', timestamp },
      ]);
      const waiting = call('await_session_event', { sessionId: child.id, timeoutMs: 1_000 });
      await f.sessions.markCompletionUnreviewed(child.id);
      expect(await waiting).toMatchObject({ data: { event: 'completed', reply: { id: 'new-result', text: 'New result.' } } });
      expect(f.sessions.delegationHandoffs.outbox.status(child.id, f.root.id)?.state).toBe('consumed');
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('cancels pending follow-up completions and refuses messages that would revive a stopped parent', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await call('prompt_session', { sessionId: child.id, prompt: 'More', requestId: 'more' });
      await call('cancel_session_delegation', { sessionId: child.id });
      expect(f.db.select().from(schema.sessionCompletionNotices).all().map(row => row.state)).toEqual(['consumed', 'consumed']);
      const childCall = await f.connect(child.id);
      await f.sessions.updateStatus(f.root.id, 'stopped');
      expect(await childCall('send_session_message', { to: 'parent', message: 'Update', requestId: 'late' }))
        .toMatchObject({ error: { code: 'session_messaging_stopped' } });
      expect(f.parentRuntime.submitPrompt).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });


  it('batches more than sixteen assignments without losing the remainder or rereading child history', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      for (let index = 1; index < 17; index++)
        await call('prompt_session', { sessionId: child.id, prompt: `Assignment ${index}`, requestId: `next-${index}`, mode: 'queue' });
      const timestamp = new Date().toISOString();
      f.runtime.getHistory.mockResolvedValue(f.runtime.submitPrompt.mock.calls.flatMap((row, index): AgentTranscriptItem[] => [
        { id: `input-${index}`, kind: 'user', content: row[1], timestamp },
        { id: `answer-${index}`, kind: 'assistant', content: `Result ${index}`, assistantPhase: 'final', timestamp },
      ]));
      f.runtime.getHistory.mockClear();
      await f.sessions.markCompletionUnreviewed(child.id);
      f.startNotices();
      await eventually(() => expect(f.db.select().from(schema.sessionCompletionNotices).all().map(row => row.state))
        .toEqual(Array.from({ length: 17 }, () => 'accepted')));
      expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(2);
      expect(f.runtime.getHistory).toHaveBeenCalledTimes(1);
      expect(f.parentRuntime.submitPrompt.mock.calls[1][1]).toContain('Result 16');
    } finally { await f.close(); }
  });

  it('never substitutes an old final when a completed follow-up has no readable final yet', async () => {
    const f = await fixture();
    try {
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.markCompletionUnreviewed(child.id);
      await call('await_session_event', { sessionId: child.id, timeoutMs: 500 });
      await call('prompt_session', { sessionId: child.id, prompt: 'Follow up', requestId: 'next' });
      await f.sessions.markCompletionUnreviewed(child.id);
      f.startNotices();
      const result = await call('await_session_event', { sessionId: child.id, timeoutMs: 1_000 });
      expect(result).toMatchObject({ data: { event: 'completed' } });
      expect(result).not.toHaveProperty('data.reply');
    } finally { await f.close(); }
  });


  it('reports an archived delegate even when its provider runtime is unavailable', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.updateStatus(child.id, 'archived');
      f.runtime.getRuntimeState.mockRejectedValue(new Error('Provider unavailable'));
      f.runtime.getRuntimeState.mockClear();
      f.startNotices();
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1));
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain(`Session #${child.id}: failed.`);
      expect(f.runtime.getRuntimeState).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });


  it('reports a failed follow-up without requiring a new successful completion version', async () => {
    const f = await fixture();
    try {
      await f.sessions.updateStatus(f.root.id, 'active');
      const call = await f.connect(f.root.id);
      await call('create_session', { provider: 'codex', requestId: 'initial', prompt: 'First' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      await f.sessions.markCompletionUnreviewed(child.id);
      await call('await_session_event', { sessionId: child.id, timeoutMs: 500 });
      await call('prompt_session', { sessionId: child.id, prompt: 'More', requestId: 'more' });
      f.runtime.getRuntimeState.mockResolvedValue({ sessionState: 'idle', runPhase: 'error', pendingPrompts: [], backgroundWork: [] });
      f.startNotices();
      await eventually(() => expect(f.parentRuntime.submitPrompt).toHaveBeenCalledTimes(1));
      expect(f.parentRuntime.submitPrompt.mock.calls[0][1]).toContain(`Session #${child.id}: failed.`);
      const failed = f.db.select().from(schema.sessionCompletionNotices).all().at(-1)!;
      expect(failed.outcome).toBe('failed');
      // A delayed collection of this failure cannot acknowledge a newly sent assignment.
      f.runtime.getRuntimeState.mockResolvedValue({ sessionState: 'running', runPhase: 'running', pendingPrompts: [], backgroundWork: [] });
      await call('prompt_session', { sessionId: child.id, prompt: 'Try a new approach', requestId: 'new' });
      f.sessions.delegationHandoffs.collected(child.id, f.root.id, undefined, failed.id);
      expect(f.sessions.delegationHandoffs.outbox.status(child.id, f.root.id)?.state).toBe('waiting');
    } finally { await f.close(); }
  });

});
