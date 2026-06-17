import { EventEmitter } from 'events';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { ToolError } from '../tool-registry/tool.types.js';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { askSessionTool } from '../tools/ask/ask-session.tool.js';
import { ASK_TOOLS } from '../tools/ask/index.js';
import { PlanChatForksService } from '../../sessions/plan-chat-forks.service.js';

function makeCtx(services: unknown): ToolContext {
  return {
    services,
    agentSessionId: 42,
    caps: {
      isAgent: true,
      canMutate: true,
      canDestroy: true,
      canUseHumanChannel: true,
    },
    cursors: new DeltaCursorStore(),
    deepLink: new DeepLinkBuilder(),
    human: {} as never,
    signal: new AbortController().signal,
    mcpSessionId: 't',
  } as unknown as ToolContext;
}

describe('ask_session tool', () => {
  it('is exported in ASK_TOOLS as a heavy, mutating tool', () => {
    expect(ASK_TOOLS).toContain(askSessionTool);
    expect(askSessionTool.name).toBe('ask_session');
    expect(askSessionTool.costClass).toBe('heavy');
    expect(askSessionTool.mutates).toBe(true);
  });

  it('answer-ready path returns { data: { answer } } and touched.forkId', async () => {
    const services = {
      sessions: { findOne: jest.fn().mockResolvedValue({ id: 7 }) },
      planChatForks: {
        ask: jest.fn().mockResolvedValue({
          forkId: 99,
          childSessionId: 99,
          answer: 'It finished the refactor.',
          running: false,
        }),
      },
    };

    const res = await askSessionTool.handler(
      { sessionId: 7, question: 'Did it finish?', timeoutMs: 30_000 },
      makeCtx(services),
    );

    expect(res.data).toEqual({ answer: 'It finished the refactor.' });
    expect(res.touched).toEqual({ forkId: 99 });
    expect(services.planChatForks.ask).toHaveBeenCalledWith(7, {
      question: 'Did it finish?',
      surface: 'agent_query',
      timeoutMs: 30_000,
      signal: expect.anything(),
    });
  });

  it('running path returns { running: true, forkId } and touched.forkId', async () => {
    const services = {
      sessions: { findOne: jest.fn().mockResolvedValue({ id: 7 }) },
      planChatForks: {
        ask: jest.fn().mockResolvedValue({
          forkId: 123,
          childSessionId: 123,
          answer: null,
          running: true,
        }),
      },
    };

    const res = await askSessionTool.handler(
      { sessionId: 7, question: 'Why?', timeoutMs: 30_000 },
      makeCtx(services),
    );

    expect(res.data).toMatchObject({ running: true, forkId: 123 });
    expect(res.touched).toEqual({ forkId: 123 });
  });

  it('throws a ToolError when the session is not found', async () => {
    const services = {
      sessions: { findOne: jest.fn().mockRejectedValue(new Error('nope')) },
      planChatForks: { ask: jest.fn() },
    };

    await expect(
      askSessionTool.handler(
        { sessionId: 404, question: 'q', timeoutMs: 30_000 },
        makeCtx(services),
      ),
    ).rejects.toBeInstanceOf(ToolError);
    expect(services.planChatForks.ask).not.toHaveBeenCalled();
  });

  it('translates a backend (busy) error into a retryable ToolError', async () => {
    const services = {
      sessions: { findOne: jest.fn().mockResolvedValue({ id: 7 }) },
      planChatForks: {
        ask: jest.fn().mockRejectedValue(new Error('The session is busy')),
      },
    };

    const err = await askSessionTool
      .handler(
        { sessionId: 7, question: 'q', timeoutMs: 30_000 },
        makeCtx(services),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).retryable).toBe(true);
  });
});

// --- PlanChatForksService.ask await/timeout behaviour ----------------------

interface FakeRuntime {
  getRuntimeState: jest.Mock;
  getHistory: jest.Mock;
  forkConversation: jest.Mock;
  submitPrompt: jest.Mock;
  setPlanMode: jest.Mock;
}

function makeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  return {
    getRuntimeState: jest.fn().mockResolvedValue({ sessionState: 'idle' }),
    getHistory: jest.fn().mockResolvedValue([]),
    forkConversation: jest
      .fn()
      .mockResolvedValue({ providerSessionId: 'prov-1' }),
    submitPrompt: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Build a PlanChatForksService with mocked db / sessionsService / moduleRef.
 * The sessionsService is a real EventEmitter so the event-driven wait works.
 */
function makeService(runtime: FakeRuntime) {
  const sessionsService = Object.assign(new EventEmitter(), {
    findOne: jest.fn().mockResolvedValue({
      id: 7,
      status: 'active',
      repoId: 1,
      workspaceId: null,
      branchName: 'main',
      worktreePath: '/wt',
      name: 'My session',
      activeAgentProvider: 'claude',
    }),
    create: jest.fn().mockResolvedValue({ id: 99 }),
    updateClaudeSessionId: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  });

  const registry = {
    getProvider: jest.fn().mockReturnValue(runtime),
    getProviderFeature: jest.fn().mockReturnValue(runtime),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(registry) };

  // findOne for the child resolves the latest provider state.
  sessionsService.findOne.mockImplementation(async (id: number) => ({
    id,
    status: 'active',
    repoId: 1,
    workspaceId: null,
    branchName: 'main',
    worktreePath: '/wt',
    name: id === 99 ? 'My session agent Q&A' : 'My session',
    activeAgentProvider: 'claude',
  }));

  const service = new PlanChatForksService(
    {} as never,
    sessionsService as never,
    moduleRef as never,
  );
  return { service, sessionsService, registry, runtime };
}

describe('PlanChatForksService.ask', () => {
  it('returns the last assistant answer once the child fork is idle', async () => {
    const runtime = makeRuntime({
      // Parent head anchor, then child idle with an answer.
      getHistory: jest
        .fn()
        // resolveParentAnchor -> parent head
        .mockResolvedValueOnce([{ id: 'm1', kind: 'user', content: 'go' }])
        // waitForAnswer fast-path -> child history with the answer
        .mockResolvedValue([
          { id: 'a1', kind: 'assistant', content: '  The answer.  ' },
        ]),
    });
    const { service } = makeService(runtime);

    const res = await service.ask(7, { question: 'q', timeoutMs: 5_000 });

    expect(res.answer).toBe('The answer.');
    expect(res.running).toBe(false);
    expect(res.forkId).toBe(99);
    expect(res.childSessionId).toBe(99);
  });

  it('creates the child fork on the agent_query surface', async () => {
    const runtime = makeRuntime({
      getHistory: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'm1', kind: 'user', content: 'go' }])
        .mockResolvedValue([
          { id: 'a1', kind: 'assistant', content: 'answer' },
        ]),
    });
    const { service, sessionsService } = makeService(runtime);

    await service.ask(7, { question: 'q', timeoutMs: 5_000 });

    expect(sessionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'agent_query' }),
    );
  });

  it('returns { answer: null, running: true } on timeout while still producing', async () => {
    const runtime = makeRuntime({
      getRuntimeState: jest.fn().mockImplementation(async (id: number) =>
        // parent (7) idle so the guard passes; child (99) keeps running.
        id === 7 ? { sessionState: 'idle' } : { sessionState: 'running' },
      ),
      getHistory: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'm1', kind: 'user', content: 'go' }])
        .mockResolvedValue([]),
    });
    const { service, sessionsService } = makeService(runtime);

    const res = await service.ask(7, { question: 'q', timeoutMs: 30 });

    expect(res.answer).toBeNull();
    expect(res.running).toBe(true);
    expect(res.forkId).toBe(99);
    // A still-running fork is kept (not cleaned up) so the caller can poll it.
    expect(sessionsService.delete).not.toHaveBeenCalled();
  });

  it('rejects when the parent session is busy producing a response', async () => {
    const runtime = makeRuntime({
      getRuntimeState: jest
        .fn()
        .mockResolvedValue({ sessionState: 'running' }),
    });
    const { service, sessionsService } = makeService(runtime);

    await expect(
      service.ask(7, { question: 'q', timeoutMs: 5_000 }),
    ).rejects.toThrow(/busy/i);
    // No fork should have been created when the parent is busy.
    expect(sessionsService.create).not.toHaveBeenCalled();
  });

  it('returns null (running) immediately when the request is already aborted', async () => {
    const runtime = makeRuntime({
      getRuntimeState: jest.fn().mockImplementation(async (id: number) =>
        id === 7 ? { sessionState: 'idle' } : { sessionState: 'running' },
      ),
      getHistory: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'm1', kind: 'user', content: 'go' }])
        .mockResolvedValue([]),
    });
    const { service } = makeService(runtime);
    const controller = new AbortController();
    controller.abort();

    const res = await service.ask(7, {
      question: 'q',
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    expect(res.answer).toBeNull();
    expect(res.running).toBe(true);
  });
});
