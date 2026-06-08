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
});
