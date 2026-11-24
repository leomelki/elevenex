import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import type {
  AgentPromptOptions,
  AgentRuntimeProvider,
} from '../../agent-runtime/agent-runtime.types.js';
import { AgentRuntimeRegistryService } from '../../agent-runtime/agent-runtime-registry.service.js';
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
      getRuntimeState: jest.fn(async () => ({ sessionState: 'idle', runPhase: 'idle', pendingPrompts: [], backgroundWork: [] })),
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
    const agentRuntime = new AgentRuntimeRegistryService([
      runtime as unknown as AgentRuntimeProvider,
    ]);
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
      workspace,
      delegates,
      connect,
      async close() {
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
      const call = await f.connect(f.root.id);
      await call('create_session', { requestId: 'review', provider: 'codex', model: 'worker', prompt: 'Review retries' });
      const { items: [child] } = await f.workspace.listSessions(f.task.id, { parentSessionId: String(f.root.id) });
      for (let index = 0; index < 2; index++)
        expect(await call('await_session_event', { sessionId: child.id, includeReply: true, timeoutMs: 500 }))
          .toMatchObject({ data: { session: { sessionId: child.id, taskId: f.task.id }, event: 'completed', reply: { id: 'final', text: '**Reviewed.**' } } });
      expect(f.sessions.delegationHandoffs.waiting(f.root.id, child.id)).toBe(false);
      expect(f.db.select().from(schema.sessionReplyReturns).all()).toMatchObject([
        { sessionId: child.id, recipientId: f.root.id, itemId: 'final' },
      ]);
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
