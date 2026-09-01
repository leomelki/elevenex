import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PiRuntimeService } from './pi-runtime.service.js';
import type { PiSessionRuntimeEvent } from './pi-runtime.types.js';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';

jest.mock('../session-title/session-title.service.js', () => ({
  SessionTitleService: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(async () => ({ PATH: '/mock/bin' })),
  findBinary: jest.fn(() => null),
  buildSpawnCommand: jest.fn((command: string) => ({ command, shell: false })),
}));

class MockWritable extends EventEmitter {
  writable = true;
  readonly writes: string[] = [];
  private nextWrite?: (chunk: string) => void;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.nextWrite?.(chunk);
    return true;
  }

  onWrite(handler: (chunk: string) => void): void {
    this.nextWrite = handler;
  }
}

type MockPiProcess = EventEmitter & {
  stdin: MockWritable;
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  pid: number;
  kill: jest.Mock;
};

const mockSpawn = jest.mocked(spawn);
const mockBuildAugmentedEnv = jest.mocked(buildAugmentedEnvAsync);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Emits a raw RPC event into the service the same way a live pi process
 * would, without going through a spawned runtime.
 */
function emitPiEvent(
  service: PiRuntimeService,
  sessionId: number,
  event: PiSessionRuntimeEvent,
): void {
  (
    service as unknown as {
      handlePiEvent(sessionId: number, event: PiSessionRuntimeEvent): void;
    }
  ).handlePiEvent(sessionId, event);
}

function createPiProcess(
  sessionFile: string,
  options?: { entries?: Record<string, unknown>[] },
): MockPiProcess {
  const child = new EventEmitter() as MockPiProcess;
  child.stdin = new MockWritable();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.pid = 1000 + Math.floor(Math.random() * 1000);
  child.kill = jest.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  });
  child.stdin.onWrite((chunk) => {
    const command = JSON.parse(chunk.trim()) as { id: string; type: string };
    if (command.type === 'get_state') {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'response',
            id: command.id,
            command: 'get_state',
            success: true,
            data: {
              sessionFile,
              model: { provider: 'anthropic', id: 'claude-sonnet' },
            },
          }) + '\n',
        ),
      );
      return;
    }
    if (command.type === 'get_entries') {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'response',
            id: command.id,
            command: 'get_entries',
            success: true,
            data: { entries: options?.entries ?? [] },
          }) + '\n',
        ),
      );
      return;
    }
    if (command.type === 'get_available_models') {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'response',
            id: command.id,
            command: 'get_available_models',
            success: true,
            data: { models: [] },
          }) + '\n',
        ),
      );
      return;
    }
    if (command.type === 'prompt') {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'response',
            id: command.id,
            command: 'prompt',
            success: true,
          }) + '\n',
        ),
      );
      child.stdout.emit('data', Buffer.from('{"type":"agent_end"}\n'));
      return;
    }
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
        }) + '\n',
      ),
    );
  });
  return child;
}

function createService(options?: {
  idleMs?: string;
  idleCap?: string;
  piSessionPath?: string;
}) {
  if (options?.idleMs) process.env.PI_RUNTIME_IDLE_MS = options.idleMs;
  if (options?.idleCap) process.env.PI_RUNTIME_IDLE_CAP = options.idleCap;
  const sessions = {
    findOne: jest.fn(async (sessionId: number) => ({
      id: sessionId,
      worktreePath: `/repo/session-${sessionId}`,
      piSessionPath: options?.piSessionPath ?? '-1',
    })),
    updateStatus: jest.fn(async () => undefined),
    updatePiSessionPath: jest.fn(async () => undefined),
  };
  const auth = {
    on: jest.fn(),
    getStatus: jest.fn(async () => ({
      isAuthenticating: false,
      output: [],
      installed: true,
      version: '1.0.0',
      authenticated: true,
      authMethod: 'api_key',
      authPath: '/Users/test/.pi/agent/auth.json',
      modelsPath: '/Users/test/.pi/agent/models.json',
    })),
  };
  return {
    service: new PiRuntimeService(
      sessions as never,
      auth as never,
      { updateRuntimeActivity: () => {} } as never,
      {
        generate: () => Promise.resolve(null),
        isAutoGeneratedName: () => false,
      } as never,
      {
        getAgentProviderDefaults: () => ({
          model: null,
          reasoningEffort: null,
        }),
      } as never,
    ),
    sessions,
  };
}

describe('PiRuntimeService lifecycle', () => {
  const originalIdleMs = process.env.PI_RUNTIME_IDLE_MS;
  const originalIdleCap = process.env.PI_RUNTIME_IDLE_CAP;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockBuildAugmentedEnv.mockResolvedValue({ PATH: '/mock/bin' });
    delete process.env.PI_RUNTIME_IDLE_MS;
    delete process.env.PI_RUNTIME_IDLE_CAP;
  });

  it('clones and slices Pi JSONL history for assistant anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fork-'));
    try {
      const sessionPath = join(root, 'session.jsonl');
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            id: 'user-entry',
            type: 'message',
            message: {
              role: 'user',
              timestamp: Date.parse('2026-05-22T10:00:00.000Z'),
              content: [{ type: 'text', text: 'hello' }],
            },
          }),
          JSON.stringify({
            id: 'assistant-entry',
            type: 'message',
            message: {
              role: 'assistant',
              timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
              content: [{ type: 'text', text: 'hi' }],
            },
          }),
          JSON.stringify({
            id: 'later-entry',
            type: 'message',
            message: {
              role: 'user',
              timestamp: Date.parse('2026-05-22T10:02:00.000Z'),
              content: [{ type: 'text', text: 'later' }],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      const { service } = createService({ piSessionPath: sessionPath });

      const result = await service.forkConversation({
        parentSessionId: 1,
        childSessionId: 2,
        anchorMessageId: 'assistant-entry',
        anchorMessageKind: 'assistant',
        childSessionName: 'Fork',
      });

      expect(result.providerSessionId).toEqual(expect.any(String));
      expect(result.anchorExcerpt).toBe('hi');
      const raw = await readFile(result.providerSessionId!, 'utf8');
      expect(raw).toContain('assistant-entry');
      expect(raw).not.toContain('later-entry');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns Pi user fork draft without copying the selected user message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fork-'));
    try {
      const sessionPath = join(root, 'session.jsonl');
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            id: 'assistant-entry',
            type: 'message',
            message: {
              role: 'assistant',
              timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
              content: [{ type: 'text', text: 'ready' }],
            },
          }),
          JSON.stringify({
            id: 'user-entry',
            type: 'message',
            message: {
              role: 'user',
              timestamp: Date.parse('2026-05-22T10:02:00.000Z'),
              content: [{ type: 'text', text: 'retry this' }],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      const { service } = createService({ piSessionPath: sessionPath });

      const result = await service.forkConversation({
        parentSessionId: 1,
        childSessionId: 2,
        anchorMessageId: 'user-entry',
        anchorMessageKind: 'user',
        childSessionName: 'Fork',
      });

      expect(result.draft).toBe('retry this');
      const raw = await readFile(result.providerSessionId!, 'utf8');
      expect(raw).toContain('assistant-entry');
      expect(raw).not.toContain('retry this');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forks a Pi conversation while a run is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fork-active-'));
    try {
      const sessionPath = join(root, 'session.jsonl');
      await writeFile(
        sessionPath,
        JSON.stringify({
          id: 'assistant-entry',
          type: 'message',
          message: {
            role: 'assistant',
            timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
            content: [{ type: 'text', text: 'hi' }],
          },
        }) + '\n',
        'utf8',
      );
      const { service } = createService({ piSessionPath: sessionPath });
      (service as any).activeRuns.set(1, {});

      const result = await service.forkConversation({
        parentSessionId: 1,
        childSessionId: 2,
        anchorMessageId: 'assistant-entry',
        anchorMessageKind: 'assistant',
        childSessionName: 'Fork',
      });

      expect(result.providerSessionId).toEqual(expect.any(String));
      expect(result.anchorExcerpt).toBe('hi');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (originalIdleMs === undefined) delete process.env.PI_RUNTIME_IDLE_MS;
    else process.env.PI_RUNTIME_IDLE_MS = originalIdleMs;
    if (originalIdleCap === undefined) delete process.env.PI_RUNTIME_IDLE_CAP;
    else process.env.PI_RUNTIME_IDLE_CAP = originalIdleCap;
    jest.useRealTimers();
  });

  it('terminates an idle detached Pi runtime after the configured timeout', async () => {
    const child = createPiProcess('/tmp/pi-session-1.jsonl');
    mockSpawn.mockReturnValue(child as never);
    const { service } = createService({ idleMs: '50' });

    await service.submitPrompt(1, 'hello');

    expect(child.kill).not.toHaveBeenCalled();

    jest.advanceTimersByTime(51);
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('queues prompts submitted while the Pi run is still initializing', async () => {
    const child = createPiProcess('/tmp/pi-session-1.jsonl');
    mockSpawn.mockReturnValue(child as never);
    const env = createDeferred<NodeJS.ProcessEnv>();
    mockBuildAugmentedEnv.mockReturnValueOnce(env.promise);
    const { service } = createService({ idleMs: '60000' });

    const firstPrompt = service.submitPrompt(1, 'first');
    while (mockBuildAugmentedEnv.mock.calls.length === 0) {
      await Promise.resolve();
    }

    await service.submitPrompt(1, 'second');
    expect((service as any).ensureRuntimeState(1).pendingPrompts).toEqual([
      expect.objectContaining({ prompt: 'second' }),
    ]);
    expect(mockSpawn).not.toHaveBeenCalled();

    env.resolve({ PATH: '/mock/bin' });
    await firstPrompt;

    const promptMessages = () =>
      child.stdin.writes
        .map((write) => JSON.parse(write) as { type: string; message?: string })
        .filter((write) => write.type === 'prompt')
        .map((write) => write.message);

    expect(promptMessages()).toEqual(['first']);

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(promptMessages()).toEqual(['first', 'second']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('closes the oldest idle detached runtime when the global cap is exceeded', async () => {
    const first = createPiProcess('/tmp/pi-session-1.jsonl');
    const second = createPiProcess('/tmp/pi-session-2.jsonl');
    mockSpawn
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const { service } = createService({ idleMs: '60000', idleCap: '1' });

    await service.submitPrompt(1, 'first');
    await service.submitPrompt(2, 'second');

    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    expect(second.kill).not.toHaveBeenCalled();
  });

  it('reconciles streamed thinking/text items with the final message_end snapshot instead of duplicating them', async () => {
    const { service } = createService();
    const sessionId = 1;
    const timestamp = Date.parse('2026-05-22T10:01:00.000Z');
    const partialMessage = {
      role: 'assistant',
      timestamp,
      content: [
        { type: 'thinking', thinking: 'partial reasoning' },
        { type: 'text', text: 'partial answer' },
      ],
    };
    const finalMessage = {
      role: 'assistant',
      timestamp,
      content: [
        { type: 'thinking', thinking: 'full reasoning' },
        { type: 'text', text: 'full answer' },
      ],
    };

    (service as any).handlePiEvent(sessionId, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      message: partialMessage,
    });
    (service as any).handlePiEvent(sessionId, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'partial reasoning',
      },
      message: partialMessage,
    });
    (service as any).handlePiEvent(sessionId, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 1 },
      message: partialMessage,
    });
    (service as any).handlePiEvent(sessionId, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 1,
        delta: 'partial answer',
      },
      message: partialMessage,
    });
    (service as any).handlePiEvent(sessionId, {
      type: 'message_end',
      message: finalMessage,
    });

    const state = await service.getRuntimeState(sessionId);
    const thinkingItems = state.liveItems.filter(
      (item) => item.kind === 'thinking',
    );
    const assistantItems = state.liveItems.filter(
      (item) => item.kind === 'assistant',
    );

    expect(thinkingItems).toHaveLength(1);
    expect(thinkingItems[0]?.content).toBe('full reasoning');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]?.content).toBe('full answer');
  });

  it('recovers history from the live RPC process when the session file has not been flushed yet', async () => {
    const missingSessionFile = join(
      tmpdir(),
      `pi-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const child = createPiProcess(missingSessionFile, {
      entries: [
        {
          id: 'user-entry',
          type: 'message',
          message: {
            role: 'user',
            timestamp: Date.parse('2026-05-22T10:00:00.000Z'),
            content: [{ type: 'text', text: 'hello' }],
          },
        },
        {
          id: 'assistant-entry',
          type: 'message',
          message: {
            role: 'assistant',
            timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
            content: [
              {
                type: 'thinking',
                thinking: 'persisted reasoning',
                textSignature: 'sig-live',
              },
            ],
          },
        },
      ],
    });
    mockSpawn.mockReturnValue(child as never);
    const { service } = createService({
      piSessionPath: missingSessionFile,
      idleMs: '60000',
    });

    await service.submitPrompt(1, 'hello');

    // Simulate the in-flight assistant message streaming after reattach: the
    // entries above are not on disk yet, and the live stream holds fresher
    // content under the same item id.
    const streamingMessage = {
      role: 'assistant',
      timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
      content: [{ type: 'thinking', thinking: '', textSignature: 'sig-live' }],
    };
    emitPiEvent(service, 1, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      message: streamingMessage,
    });
    emitPiEvent(service, 1, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'streamed reasoning',
      },
      message: streamingMessage,
    });

    const history = await service.getHistory(1);

    expect(history.map((item) => item.kind)).toEqual(['user', 'thinking']);
    expect(history[0]?.content).toBe('hello');
    // The live copy wins over the persisted snapshot for the same id.
    expect(history[1]?.content).toBe('streamed reasoning');

    // Reading history must not wipe the in-flight streamed items: runtime
    // snapshots sent to reattaching clients still need them.
    const state = await service.getRuntimeState(1);
    expect(state.liveItems.map((item) => item.kind)).toEqual(['thinking']);
    expect(state.liveItems[0]?.content).toBe('streamed reasoning');
  });

  it('overlays streamed live items on flushed file history without duplicating them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-history-overlay-'));
    try {
      const sessionPath = join(root, 'session.jsonl');
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            id: 'user-entry',
            type: 'message',
            message: {
              role: 'user',
              timestamp: Date.parse('2026-05-22T10:00:00.000Z'),
              content: [{ type: 'text', text: 'hello' }],
            },
          }),
          JSON.stringify({
            id: 'assistant-entry',
            type: 'message',
            message: {
              role: 'assistant',
              timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
              content: [
                {
                  type: 'thinking',
                  thinking: 'persisted reasoning',
                  textSignature: 'sig-file',
                },
              ],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      const { service } = createService({ piSessionPath: sessionPath });

      const streamingMessage = {
        role: 'assistant',
        timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
        content: [
          { type: 'thinking', thinking: '', textSignature: 'sig-file' },
        ],
      };
      emitPiEvent(service, 1, {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
        message: streamingMessage,
      });
      emitPiEvent(service, 1, {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'fresher streamed reasoning',
        },
        message: streamingMessage,
      });

      const history = await service.getHistory(1);

      expect(history.map((item) => item.kind)).toEqual(['user', 'thinking']);
      expect(history[1]?.id).toBe('sig-file:thinking_start:0');
      expect(history[1]?.content).toBe('fresher streamed reasoning');

      const state = await service.getRuntimeState(1);
      expect(state.liveItems).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns the streamed live items when neither session file nor runtime exists', async () => {
    const { service } = createService();

    const streamingMessage = {
      role: 'assistant',
      timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
      content: [{ type: 'thinking', thinking: '', textSignature: 'sig-cold' }],
    };
    emitPiEvent(service, 1, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      message: streamingMessage,
    });
    emitPiEvent(service, 1, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'orphaned stream',
      },
      message: streamingMessage,
    });

    const history = await service.getHistory(1);

    expect(history.map((item) => item.kind)).toEqual(['thinking']);
    expect(history[0]?.content).toBe('orphaned stream');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not spawn a runtime or persist a Pi session path when fetching autocomplete for a session with no active run', async () => {
    const { service, sessions } = createService();

    const items = await service.getAutocompleteItems(1);

    expect(items).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(sessions.updatePiSessionPath).not.toHaveBeenCalled();
  });

  it('queries the already-running Pi process for autocomplete instead of spawning a new one', async () => {
    const child = createPiProcess('/tmp/pi-session-1.jsonl');
    mockSpawn.mockReturnValue(child as never);
    const { service } = createService();

    await service.submitPrompt(1, 'first');
    await service.getAutocompleteItems(1);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const sentTypes = child.stdin.writes.map(
      (write) => (JSON.parse(write) as { type: string }).type,
    );
    expect(sentTypes).toContain('get_commands');
  });
});
