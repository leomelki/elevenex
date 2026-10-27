jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSessionRuntime } from './claude-session-runtime.js';

type MockQuery = ReturnType<typeof createMockQuery>;

function createMockQuery() {
  const outputQueue: any[] = [];
  let outputWaiter: {
    resolve: (value: IteratorResult<any>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let closed = false;

  const flushWaiter = (): void => {
    if (!outputWaiter) return;
    const waiter = outputWaiter;
    outputWaiter = null;
    if (outputQueue.length > 0) {
      waiter.resolve({ done: false, value: outputQueue.shift() });
      return;
    }
    if (closed) {
      waiter.resolve({ done: true, value: undefined });
    }
  };

  const mockQuery = {
    initializationResult: jest.fn().mockResolvedValue({}),
    close: jest.fn(() => {
      closed = true;
      flushWaiter();
    }),
    interrupt: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
    stopTask: jest.fn().mockResolvedValue(undefined),
    backgroundTasks: jest.fn().mockResolvedValue(true),
    supportedModels: jest.fn().mockResolvedValue([]),
    getContextUsage: jest.fn().mockResolvedValue({
      model: 'sonnet',
      totalTokens: 0,
      maxTokens: 0,
      percentage: 0,
      apiUsage: undefined,
      autoCompactThreshold: 0,
      isAutoCompactEnabled: false,
      memoryFiles: [],
      mcpTools: [],
    }),
    emit(message: any) {
      outputQueue.push(message);
      flushWaiter();
    },
    fail(error: unknown) {
      if (outputWaiter) {
        const waiter = outputWaiter;
        outputWaiter = null;
        waiter.reject(error);
      } else {
        outputQueue.push(Promise.reject(error));
      }
    },
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (outputQueue.length > 0) {
          const next = outputQueue.shift();
          return { done: false, value: await next };
        }
        if (closed) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<any>>((resolve, reject) => {
          outputWaiter = { resolve, reject };
        });
      },
    }),
  };

  return mockQuery;
}

function createRuntime() {
  const queries: MockQuery[] = [];
  const messages: any[] = [];
  const fatalErrors: unknown[] = [];
  const closed: number[] = [];
  const warmStates: string[] = [];

  (query as jest.Mock).mockImplementation(() => {
    const mockQuery = createMockQuery();
    queries.push(mockQuery);
    return mockQuery;
  });

  const runtime = new ClaudeSessionRuntime({
    sessionId: 7,
    options: { cwd: '/tmp/project' },
    onMessage: (message) => {
      messages.push(message);
    },
    onFatal: (error) => {
      fatalErrors.push(error);
    },
    onClosed: () => {
      closed.push(Date.now());
    },
    onWarmStateChange: (state) => {
      warmStates.push(state);
    },
    prewarmIdleShutdownMs: 90_000,
    postTurnIdleShutdownMs: 300_000,
  });

  return { runtime, queries, messages, fatalErrors, closed, warmStates };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForQuery(queries: MockQuery[], count = 1): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (queries.length >= count) return;
    await flushAsync();
  }
  throw new Error(
    `Expected ${count} query instance(s), got ${queries.length}.`,
  );
}

describe('ClaudeSessionRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('idle shutdown', () => {
    const POST_TURN_IDLE_MS = 300_000;
    const input = {
      type: 'user',
      message: { role: 'user', content: 'Start a background task' },
      parent_tool_use_id: null,
      session_id: '',
    } as any;
    const sessionState = (state: string) => ({
      type: 'system',
      subtype: 'session_state_changed',
      state,
    });

    beforeEach(() => {
      // The helpers flush the message pump with setImmediate.
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    async function finishSubmittedTurn() {
      const harness = createRuntime();
      const turn = harness.runtime.submitTurn(input);
      await waitForQuery(harness.queries);
      harness.queries[0].emit({ type: 'result', subtype: 'success' });
      await turn;
      return harness;
    }

    // Regression: a background task's completion notification starts a turn
    // inside the CLI. Nothing was submitted, so the runtime looked idle and the
    // post-turn timer closed it mid-turn, before the model said anything.
    it('stays open while the CLI runs a turn it started itself', async () => {
      const { runtime, queries, closed } = await finishSubmittedTurn();

      queries[0].emit(sessionState('running'));
      await flushAsync();
      expect(runtime.isIdle).toBe(false);

      jest.advanceTimersByTime(POST_TURN_IDLE_MS);
      await flushAsync();
      expect(queries[0].close).not.toHaveBeenCalled();

      // The countdown restarts when the CLI reports the turn over.
      queries[0].emit(sessionState('idle'));
      await flushAsync();
      expect(runtime.isIdle).toBe(true);
      jest.advanceTimersByTime(POST_TURN_IDLE_MS - 1);
      await flushAsync();
      expect(queries[0].close).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await flushAsync();
      expect(queries[0].close).toHaveBeenCalledTimes(1);
      expect(closed).toHaveLength(1);
    });

    it('treats a turn waiting on a permission decision as busy', async () => {
      const { runtime, queries } = await finishSubmittedTurn();

      queries[0].emit(sessionState('requires_action'));
      await flushAsync();

      expect(runtime.isIdle).toBe(false);
      jest.advanceTimersByTime(POST_TURN_IDLE_MS);
      await flushAsync();
      expect(queries[0].close).not.toHaveBeenCalled();
      await runtime.close();
    });

    it('still shuts down on schedule when the CLI never reports its state', async () => {
      const { runtime, queries } = await finishSubmittedTurn();

      expect(runtime.isIdle).toBe(true);
      jest.advanceTimersByTime(POST_TURN_IDLE_MS);
      await flushAsync();
      expect(queries[0].close).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps one streaming query across multiple turns', async () => {
    const { runtime, queries, messages } = createRuntime();
    const firstInput = {
      type: 'user',
      message: { role: 'user', content: 'First' },
      parent_tool_use_id: null,
      session_id: '',
    } as any;
    const secondInput = {
      type: 'user',
      message: { role: 'user', content: 'Second' },
      parent_tool_use_id: null,
      session_id: '',
    } as any;

    const firstTurn = runtime.submitTurn(firstInput);
    await waitForQuery(queries);

    const prompt = (query as jest.Mock).mock.calls[0][0]
      .prompt as AsyncIterable<any>;
    const promptIterator = prompt[Symbol.asyncIterator]();
    await expect(promptIterator.next()).resolves.toEqual({
      done: false,
      value: firstInput,
    });

    queries[0].emit({ type: 'result', subtype: 'success' });
    await firstTurn;

    const secondTurn = runtime.submitTurn(secondInput);
    await expect(promptIterator.next()).resolves.toEqual({
      done: false,
      value: secondInput,
    });
    queries[0].emit({ type: 'result', subtype: 'success' });
    await secondTurn;

    expect(query).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([
      { type: 'result', subtype: 'success' },
      { type: 'result', subtype: 'success' },
    ]);

    await runtime.close();
  });

  it('serializes queued turns onto the same prompt stream', async () => {
    const { runtime, queries } = createRuntime();
    const firstInput = {
      type: 'user',
      message: { role: 'user', content: 'First' },
      parent_tool_use_id: null,
      session_id: '',
    } as any;
    const secondInput = {
      type: 'user',
      message: { role: 'user', content: 'Second' },
      parent_tool_use_id: null,
      session_id: '',
    } as any;

    const firstTurn = runtime.submitTurn(firstInput);
    const secondTurn = runtime.submitTurn(secondInput);
    await waitForQuery(queries);

    const prompt = (query as jest.Mock).mock.calls[0][0]
      .prompt as AsyncIterable<any>;
    const promptIterator = prompt[Symbol.asyncIterator]();
    await expect(promptIterator.next()).resolves.toEqual({
      done: false,
      value: firstInput,
    });

    queries[0].emit({ type: 'result', subtype: 'success' });
    await firstTurn;
    await expect(promptIterator.next()).resolves.toEqual({
      done: false,
      value: secondInput,
    });
    queries[0].emit({ type: 'result', subtype: 'success' });
    await secondTurn;

    expect(query).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it('resolves the active turn when interrupted', async () => {
    const { runtime, queries } = createRuntime();
    const turn = runtime.submitTurn({
      type: 'user',
      message: { role: 'user', content: 'Stop' },
      parent_tool_use_id: null,
      session_id: '',
    } as any);
    await waitForQuery(queries);

    await runtime.interrupt();

    await expect(turn).resolves.toBeUndefined();
    expect(queries[0].interrupt).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it('rejects the active turn and reports fatal runtime errors', async () => {
    const { runtime, queries, fatalErrors } = createRuntime();
    const turn = runtime.submitTurn({
      type: 'user',
      message: { role: 'user', content: 'Crash' },
      parent_tool_use_id: null,
      session_id: '',
    } as any);
    await waitForQuery(queries);

    const error = new Error('runtime crashed');
    queries[0].fail(error);

    await expect(turn).rejects.toThrow('runtime crashed');
    expect(fatalErrors).toEqual([error]);
  });

  it('rejects the active turn when the query exits before a result', async () => {
    const { runtime, queries, fatalErrors } = createRuntime();
    const turn = runtime.submitTurn({
      type: 'user',
      message: { role: 'user', content: 'Exit early' },
      parent_tool_use_id: null,
      session_id: '',
    } as any);
    await waitForQuery(queries);

    queries[0].close();

    await expect(turn).rejects.toThrow(
      'Claude runtime exited before completing the turn.',
    );
    expect(fatalErrors).toEqual([]);
  });

  it('forwards model and permission changes to a warm query', async () => {
    const { runtime, queries } = createRuntime();

    await runtime.ensureStarted('prewarm');
    await runtime.setModel('opus');
    await runtime.setPermissionMode('acceptEdits');

    expect(queries[0].setModel).toHaveBeenCalledWith('opus');
    expect(queries[0].setPermissionMode).toHaveBeenCalledWith('acceptEdits');

    await runtime.close();
  });

  it('never starts a cold or exited query for live context telemetry', async () => {
    const { runtime, queries } = createRuntime();
    await expect(runtime.getContextUsage(false)).rejects.toThrow(
      'not available',
    );
    await expect(runtime.supportedModels(false)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await runtime.ensureStarted('prewarm');
    await runtime.getContextUsage(false);
    expect(queries).toHaveLength(1);
    queries[0].close();
    await flushAsync();
    await expect(runtime.getContextUsage(false)).rejects.toThrow(
      'not available',
    );
    expect(queries).toHaveLength(1);
    await runtime.close();
  });

  it('prewarms without submitting a prompt', async () => {
    const { runtime, queries, warmStates } = createRuntime();

    await runtime.ensureStarted('prewarm');

    expect(query).toHaveBeenCalledTimes(1);
    expect(queries[0].initializationResult).toHaveBeenCalledTimes(1);
    expect(runtime.warmState).toBe('warm');
    expect(warmStates).toEqual(['prewarming', 'warm']);
    expect(runtime.hasSubmittedTurn).toBe(false);

    await runtime.close();
  });
  it('accepts a prompt before its native result and preserves later live inputs', async () => {
    const { runtime, queries } = createRuntime();
    const accepted = jest.fn();
    const first = runtime.submitTurn(
      {
        type: 'user',
        uuid: 'first',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'First' },
      },
      accepted,
    );
    let finished = false;
    void first.then(() => {
      finished = true;
    });
    await flushAsync();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    runtime.setCliVersion('2.1.296');
    runtime.steer({
      type: 'user',
      uuid: 'guide',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Guidance' },
    });
    expect(queries[0].interrupt).not.toHaveBeenCalled();
    queries[0].emit({ type: 'result', user_message_uuid: 'first' });
    await flushAsync();
    expect(finished).toBe(false);
    queries[0].emit({ type: 'result', user_message_uuid: 'guide' });
    await first;
    await runtime.close();
  });
  it('does not let an unrelated autonomous result complete a user submission', async () => {
    const { runtime, queries } = createRuntime();
    let finished = false;
    const turn = runtime
      .submitTurn({
        type: 'user',
        uuid: 'user-send',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Work' },
      })
      .then(() => {
        finished = true;
      });
    await flushAsync();
    queries[0].emit({ type: 'result', user_message_uuid: 'notification' });
    await flushAsync();
    expect(finished).toBe(false);
    queries[0].emit({ type: 'result', user_message_uuid: 'user-send' });
    await turn;
    await runtime.close();
  });
  it('targets one native task and tracks independent input outside a submitted turn', async () => {
    const { runtime, queries } = createRuntime();
    await runtime.ensureStarted();
    runtime.setCliVersion('2.1.296');
    runtime.steer({
      type: 'user',
      uuid: 'followup',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Follow up' },
    });
    expect(runtime.ownsInput('followup')).toBe(true);
    await runtime.stopTask('child');
    await runtime.backgroundTasks('dispatch');
    expect(queries[0].stopTask).toHaveBeenCalledWith('child');
    expect(queries[0].backgroundTasks).toHaveBeenCalledWith('dispatch');
    expect(queries[0].close).not.toHaveBeenCalled();
    queries[0].emit({ type: 'result', user_message_uuid: 'followup' });
    await flushAsync();
    expect(runtime.pendingInputCount).toBe(0);
    await runtime.close();
  });
});
