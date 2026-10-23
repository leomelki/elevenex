import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
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

interface FakeRuntime extends EventEmitter {
  getRuntimeState: jest.Mock;
  getHistory: jest.Mock;
  forkConversation: jest.Mock;
  submitPrompt: jest.Mock;
  setPlanMode: jest.Mock;
}

function makeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  return Object.assign(new EventEmitter(), {
    getRuntimeState: jest.fn().mockResolvedValue({ sessionState: 'idle' }),
    getHistory: jest.fn().mockResolvedValue([]),
    forkConversation: jest
      .fn()
      .mockResolvedValue({ providerSessionId: 'prov-1' }),
    submitPrompt: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
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
        // Child baseline, then the post-question answer
        .mockResolvedValueOnce([])
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
        .mockResolvedValueOnce([])
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
        .mockResolvedValueOnce([])
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
      getRuntimeState: jest.fn().mockResolvedValue({ sessionState: 'running' }),
    });
    const { service, sessionsService } = makeService(runtime);

    await expect(
      service.ask(7, { question: 'q', timeoutMs: 5_000 }),
    ).rejects.toThrow(/busy/i);
    // No fork should have been created when the parent is busy.
    expect(sessionsService.create).not.toHaveBeenCalled();
  });

  it('does not create or dispatch a child for an already aborted request', async () => {
    const { service, sessionsService, runtime } = makeService(makeRuntime());
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.ask(7, { question: 'q', signal: controller.signal }),
    ).rejects.toThrow();
    expect(sessionsService.create).not.toHaveBeenCalled();
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const INHERITED = [
  { id: 'parent-answer', kind: 'assistant', content: 'Parent reply.' },
];
function queryFixture() {
  const submission = deferred<void>();
  const runtime = makeRuntime({
    getHistory: jest.fn().mockResolvedValue(INHERITED),
    submitPrompt: jest.fn().mockReturnValue(submission.promise),
  });
  return { ...makeService(runtime), submission };
}

describe('PlanChatForksService.ask deadline regressions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns a live handle while submit remains pending and observes a late rejection', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { service, runtime, sessionsService, submission } = queryFixture();
    const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({
      answer: null,
      running: true,
      childSessionId: 99,
    });
    expect(sessionsService.delete).not.toHaveBeenCalled();
    expect(runtime.listenerCount('event')).toBe(0);
    expect(sessionsService.listenerCount('session-status-changed')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    submission.reject(new Error('late submit failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('late submit failure'),
    );
  });

  it('cancels promptly during deferred submit and removes timers and listeners', async () => {
    const { service, runtime, sessionsService, submission } = queryFixture();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const pending = service.ask(7, {
      question: 'q',
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      answer: null,
      running: true,
    });
    expect(runtime.listenerCount('event')).toBe(0);
    expect(sessionsService.listenerCount('session-status-changed')).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    expect(sessionsService.delete).not.toHaveBeenCalled();
    submission.resolve();
  });

  it('does not restart the deadline when deferred submission finally resolves', async () => {
    const { service, submission } = queryFixture();
    const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
    await jest.advanceTimersByTimeAsync(40);
    submission.resolve();
    await jest.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({
      answer: null,
      running: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'run_state',
    'runtime_snapshot',
    'result',
    'history_snapshot',
    'terminal',
  ])('returns a new answer on %s before submit resolves', async (eventType) => {
    const { service, runtime, submission } = queryFixture();
    const pending = service.ask(7, { question: 'q', timeoutMs: 5_000 });
    await jest.advanceTimersByTimeAsync(0);
    runtime.getHistory.mockResolvedValue([
      ...INHERITED,
      { id: 'child-answer', kind: 'assistant', content: '  Child reply.  ' },
    ]);
    runtime.emit('event', {
      type: eventType,
      payload: { sessionId: 99, sessionState: 'idle', runPhase: 'idle' },
    });
    await expect(pending).resolves.toMatchObject({
      answer: 'Child reply.',
      running: false,
    });
    expect(jest.getTimerCount()).toBe(0);
    submission.resolve();
  });

  it('never returns an inherited answer when submission is a no-op', async () => {
    const { service, submission } = queryFixture();
    submission.resolve();
    const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({
      answer: null,
      running: true,
    });
  });

  it.each(['state', 'history'])(
    'bounds the first post-dispatch %s read',
    async (read) => {
      const { service, runtime, sessionsService, submission } = queryFixture();
      const slow = deferred<never>();
      if (read === 'state')
        runtime.getRuntimeState.mockImplementation((id: number) =>
          id === 7 ? Promise.resolve({ sessionState: 'idle' }) : slow.promise,
        );
      else
        runtime.getHistory.mockImplementation((id: number) =>
          id === 7 || !runtime.submitPrompt.mock.calls.length
            ? Promise.resolve(INHERITED)
            : slow.promise,
        );
      const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
      await jest.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toMatchObject({
        answer: null,
        running: true,
      });
      expect(sessionsService.delete).not.toHaveBeenCalled();
      expect(runtime.listenerCount('event')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      slow.reject(new Error('late read failure'));
      submission.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('propagates submit rejection while a history read is hung and cleans up', async () => {
    const { service, runtime, sessionsService, submission } = queryFixture();
    runtime.getHistory.mockImplementation((id: number) =>
      id === 7 || !runtime.submitPrompt.mock.calls.length
        ? Promise.resolve(INHERITED)
        : new Promise(() => {}),
    );
    const pending = service.ask(7, { question: 'q', timeoutMs: 5_000 });
    const rejected = expect(pending).rejects.toThrow('submit failed');
    await jest.advanceTimersByTimeAsync(0);
    submission.reject(new Error('submit failed'));
    await rejected;
    expect(sessionsService.delete).toHaveBeenCalledWith(99);
    expect(runtime.listenerCount('event')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects runtime failure rather than returning parent history', async () => {
    const { service, runtime, sessionsService, submission } = queryFixture();
    runtime.getRuntimeState.mockImplementation(async (id: number) =>
      id === 7
        ? { sessionState: 'idle' }
        : { runPhase: 'error', lastError: 'child failed' },
    );
    await expect(service.ask(7, { question: 'q' })).rejects.toThrow(
      'child failed',
    );
    expect(sessionsService.delete).toHaveBeenCalledWith(99);
    expect(jest.getTimerCount()).toBe(0);
    submission.resolve();
  });

  it.each(['parent state', 'parent history', 'baseline'])(
    'bounds %s before dispatch without claiming the question is running',
    async (read) => {
      const { service, runtime, sessionsService } = queryFixture();
      const slow = deferred<never>();
      if (read === 'parent state')
        runtime.getRuntimeState.mockReturnValue(slow.promise);
      else
        runtime.getHistory.mockImplementation((id: number) =>
          read === 'parent history' || id === 99
            ? slow.promise
            : Promise.resolve(INHERITED),
        );
      const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
      const rejected = expect(pending).rejects.toThrow(
        'not submitted before the deadline',
      );
      await jest.advanceTimersByTimeAsync(50);
      await rejected;
      expect(runtime.submitPrompt).not.toHaveBeenCalled();
      slow.reject(new Error('late setup failure'));
      await jest.advanceTimersByTimeAsync(0);
      if (read === 'baseline')
        expect(sessionsService.delete).toHaveBeenCalledWith(99);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('cleans up a child whose creation completes after deadline and never dispatches', async () => {
    const { service, runtime, sessionsService } = queryFixture();
    const creation = deferred<{ id: number }>();
    sessionsService.create.mockReturnValue(creation.promise);
    const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
    const rejected = expect(pending).rejects.toThrow('not submitted');
    await jest.advanceTimersByTimeAsync(50);
    await rejected;
    creation.resolve({ id: 99 });
    await jest.advanceTimersByTimeAsync(0);
    expect(sessionsService.delete).toHaveBeenCalledWith(99);
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });

  it('coalesces event storms with single-flight state/history polling', async () => {
    const { service, runtime, sessionsService, submission } = queryFixture();
    const slow = deferred<typeof INHERITED>();
    runtime.getHistory.mockImplementation((id: number) =>
      id === 7 || !runtime.submitPrompt.mock.calls.length
        ? Promise.resolve(INHERITED)
        : slow.promise,
    );
    const pending = service.ask(7, { question: 'q', timeoutMs: 5_000 });
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      sessionsService.emit('session-status-changed', { sessionId: 99 });
      runtime.emit('event', { type: 'complete', payload: { sessionId: 99 } });
    }
    await jest.advanceTimersByTimeAsync(2_000);
    expect(runtime.getHistory).toHaveBeenCalledTimes(3); // parent, baseline, one child read
    slow.resolve([
      ...INHERITED,
      { id: 'answer', kind: 'assistant', content: 'Answer' },
    ]);
    await expect(pending).resolves.toMatchObject({ answer: 'Answer' });
    expect(jest.getTimerCount()).toBe(0);
    submission.resolve();
  });

  it('bounds reads during message/thinking delta storms and retains the 1s fallback', async () => {
    const { service, runtime, submission } = queryFixture();
    runtime.getRuntimeState.mockImplementation(async (id: number) =>
      id === 7 ? { sessionState: 'idle' } : { sessionState: 'running' },
    );
    const pending = service.ask(7, { question: 'q', timeoutMs: 2_050 });
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      for (const type of ['message_delta', 'thinking_delta']) {
        runtime.emit('event', { type, payload: { sessionId: 99 } });
        // Let fast reads settle between tokens: overlap coalescing alone is insufficient.
        await jest.advanceTimersByTimeAsync(0);
      }
    }
    expect(runtime.getRuntimeState).toHaveBeenCalledTimes(2);
    expect(runtime.getHistory).toHaveBeenCalledTimes(2); // parent and fork baseline only
    await jest.advanceTimersByTimeAsync(1_000);
    expect(runtime.getRuntimeState).toHaveBeenCalledTimes(3);
    expect(runtime.getHistory).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1_050);
    await expect(pending).resolves.toMatchObject({ running: true });
    expect(jest.getTimerCount()).toBe(0);
    submission.resolve();
  });

  it('handles runtime errors immediately while a history read is hung', async () => {
    const { service, runtime, submission } = queryFixture();
    runtime.getHistory.mockImplementation((id: number) =>
      id === 7 || !runtime.submitPrompt.mock.calls.length
        ? Promise.resolve(INHERITED)
        : new Promise(() => {}),
    );
    const pending = service.ask(7, { question: 'q', timeoutMs: 5_000 });
    const rejected = expect(pending).rejects.toThrow('runtime failed');
    await jest.advanceTimersByTimeAsync(0);
    runtime.emit('event', {
      type: 'error',
      payload: { sessionId: 99, message: 'runtime failed' },
    });
    await rejected;
    expect(runtime.listenerCount('event')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    submission.resolve();
  });

  it('discards a history result if the child started running during the read', async () => {
    const { service, runtime, submission } = queryFixture();
    const history = deferred<typeof INHERITED>();
    runtime.getHistory.mockImplementation((id: number) =>
      id === 7 || !runtime.submitPrompt.mock.calls.length
        ? Promise.resolve(INHERITED)
        : history.promise,
    );
    const pending = service.ask(7, { question: 'q', timeoutMs: 50 });
    await jest.advanceTimersByTimeAsync(0);
    runtime.getRuntimeState.mockResolvedValue({ sessionState: 'running' });
    runtime.emit('event', {
      type: 'run_state',
      payload: { sessionId: 99, sessionState: 'running' },
    });
    history.resolve([
      ...INHERITED,
      { id: 'partial', kind: 'assistant', content: 'Still streaming' },
    ]);
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({
      answer: null,
      running: true,
    });
    expect(jest.getTimerCount()).toBe(0);
    submission.resolve();
  });

  it('refuses a fork without a provider conversation', async () => {
    const { service, runtime, sessionsService } = queryFixture();
    runtime.forkConversation.mockResolvedValue({ providerSessionId: null });
    await expect(service.ask(7, { question: 'q' })).rejects.toThrow(
      'Could not fork',
    );
    expect(sessionsService.delete).toHaveBeenCalledWith(99);
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });
});
