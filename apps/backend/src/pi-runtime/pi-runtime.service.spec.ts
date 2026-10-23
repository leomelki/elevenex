import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PiRuntimeService } from './pi-runtime.service.js';
import { PiSessionRuntime } from './pi-session-runtime.js';
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
  // Emit readiness after startup actually attaches its stdout listener.
  child.stdout.on('newListener', (event) => {
    if (event === 'data')
      void Promise.resolve().then(() =>
        child.stdout.emit(
          'data',
          Buffer.from(
            '{"type":"extension_ui_request","statusKey":"elevenex_agent_ready","statusText":"ready"}\n',
          ),
        ),
      );
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
  let piSessionPath = options?.piSessionPath ?? '-1';
  const sessions = {
    findOne: jest.fn(async (sessionId: number) => ({
      id: sessionId,
      worktreePath: `/repo/session-${sessionId}`,
      piSessionPath,
    })),
    updateStatus: jest.fn(async () => undefined),
    updatePiSessionPath: jest.fn(async (_sessionId: number, path: string) => {
      piSessionPath = path;
    }),
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
  const tokens = { ensureToken: jest.fn().mockResolvedValue('evx_pi_test') };
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
      tokens as never,
    ),
    sessions,
    tokens,
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

  it('queues one fresh CLI probe after an automatic probe for concurrent reloads', async () => {
    const { service } = createService();
    const runtimeService = service as any;
    const previous = createDeferred<void>();
    runtimeService.modelsRefreshPromise = previous.promise.finally(() => {
      runtimeService.modelsRefreshPromise = null;
    });
    const start = jest
      .spyOn(PiSessionRuntime.prototype, 'start')
      .mockResolvedValue(undefined);
    const send = jest
      .spyOn(PiSessionRuntime.prototype, 'send')
      .mockResolvedValue({
        models: [{ provider: 'local', id: 'new', name: 'New' }],
      });
    const stop = jest
      .spyOn(PiSessionRuntime.prototype, 'stop')
      .mockResolvedValue(undefined);
    try {
      const first = service.getModelCatalog(true);
      const second = service.getModelCatalog(true);
      expect(start).not.toHaveBeenCalled();
      previous.resolve();
      const results = await Promise.all([first, second]);
      expect(results.map((catalog) => catalog.models[0].id)).toEqual([
        'local/new',
        'local/new',
      ]);
      expect(start).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      runtimeService.runtimes.set(7, {
        runtime: {
          send: jest
            .fn()
            .mockResolvedValue({
              models: [{ provider: 'project', id: 'old', reasoning: true }],
            }),
        },
      });
      await runtimeService.refreshModels(7);
      expect((await service.getModelCatalog()).models[0].id).toBe('local/new');
      runtimeService.runtimes.delete(7);
    } finally {
      start.mockRestore();
      send.mockRestore();
      stop.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('coalesces concurrent session startup into one Pi process', async () => {
    const { service } = createService();
    mockSpawn.mockReturnValue(
      createPiProcess('/tmp/pi-session.jsonl') as never,
    );
    const runtimeService = service as unknown as {
      ensureRuntime(id: number): Promise<unknown>;
    };
    const [first, second] = await Promise.all([
      runtimeService.ensureRuntime(1),
      runtimeService.ensureRuntime(1),
    ]);
    expect(first).toBe(second);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it.each([
    'prompt lookup',
    'runtime lookup',
    'token',
    'config directory',
    'extension path',
    'environment',
    'status update',
    'change capture',
  ])(
    'drains cleanup during %s without a late prompt or publication',
    async (stage) => {
      jest.useRealTimers();
      const { service, sessions, tokens } = createService();
      const session = await sessions.findOne(1);
      const pending = createDeferred<any>();
      const entered = createDeferred<void>();
      const pause = () => {
        entered.resolve();
        return pending.promise;
      };
      let restore: (() => void) | undefined;
      let configDir: string | undefined;
      let value: unknown;
      const child = createPiProcess('/tmp/pi-session.jsonl');
      mockSpawn.mockReturnValue(child as never);
      switch (stage) {
        case 'prompt lookup':
        case 'runtime lookup':
          sessions.findOne.mockImplementationOnce(pause);
          value = session;
          break;
        case 'token':
          tokens.ensureToken.mockImplementationOnce(pause);
          value = 'token';
          break;
        case 'config directory': {
          sessions.findOne.mockResolvedValue({
            ...session,
            surface: 'agent',
          } as any);
          configDir = await mkdtemp(join(tmpdir(), 'pi-cleanup-race-'));
          const spy = jest.spyOn(fs, 'mkdtemp').mockImplementationOnce(pause);
          restore = () => spy.mockRestore();
          value = configDir;
          break;
        }
        case 'extension path': {
          const spy = jest
            .spyOn(service as any, 'agentExtensionPath')
            .mockImplementationOnce(pause);
          restore = () => spy.mockRestore();
          value = '/mock/extension.js';
          break;
        }
        case 'environment':
          mockBuildAugmentedEnv.mockImplementationOnce(pause);
          value = { PATH: '/mock/bin' };
          break;
        case 'status update':
          sessions.updateStatus.mockImplementationOnce(pause);
          break;
        case 'change capture':
          (service as any).turnChanges = {
            begin: jest.fn(pause),
            finish: jest.fn(),
            cancelSession: jest.fn(),
          };
          break;
      }
      const start = (
        stage === 'runtime lookup'
          ? (service as any).ensureRuntime(1)
          : service.submitPrompt(1, 'Never dispatch this')
      ).catch(() => undefined);
      try {
        await entered.promise;
        const events = jest.fn();
        service.on('event', events);
        let cleaned = false;
        const cleanup = service.cleanupSession(1).then(() => {
          cleaned = true;
        });
        await Promise.resolve();
        expect(cleaned).toBe(false);
        await expect(service.submitPrompt(1, 'During cleanup')).rejects.toThrow(
          'closed',
        );
        pending.resolve(value);
        await Promise.all([start, cleanup]);
        expect(
          child.stdin.writes
            .map((line) => JSON.parse(line))
            .filter((command) => command.type === 'prompt'),
        ).toEqual([]);
        if (stage !== 'status update' && stage !== 'change capture')
          expect(mockSpawn).not.toHaveBeenCalled();
        expect(events).not.toHaveBeenCalled();
        for (const map of [
          'runtimes',
          'runtimeStarts',
          'initializingRuns',
          'runtimeStates',
          'activeRuns',
          'promptTasks',
        ]) {
          expect((service as any)[map].has(1)).toBe(false);
        }
        if (configDir)
          await expect(fs.stat(configDir)).rejects.toMatchObject({
            code: 'ENOENT',
          });
      } finally {
        pending.resolve(value);
        await start;
        restore?.();
        await service.onModuleDestroy();
        if (configDir) await rm(configDir, { recursive: true, force: true });
      }
    },
  );

  it('drains module shutdown while a runtime is still being created', async () => {
    const { service, tokens } = createService();
    const pending = createDeferred<string>();
    const entered = createDeferred<void>();
    tokens.ensureToken.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const start = service.submitPrompt(1, 'Old prompt');
    await entered.promise;
    const shutdown = service.onModuleDestroy();
    pending.resolve('token');
    await Promise.all([start, shutdown]);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect((service as any).runtimeStarts.size).toBe(0);
    await expect(service.submitPrompt(1, 'After shutdown')).rejects.toThrow(
      'closed',
    );
  });

  it('ignores an old exit after cleanup and reopen without touching the replacement run', async () => {
    jest.useRealTimers();
    const { service } = createService();
    mockSpawn.mockImplementation(
      () => createPiProcess('/tmp/pi-session.jsonl') as never,
    );
    const old = await (service as any).ensureRuntime(1);
    await service.cleanupSession(1);
    await (service as any).ensureRuntime(1);
    const replacement = (service as any).runtimes.get(1);
    const run = { resolveCompletion: jest.fn() };
    (service as any).activeRuns.set(1, run);
    const events = jest.fn();
    service.on('event', events);
    old.emit('exit', { message: 'Old process finally exited' });
    expect((service as any).runtimes.get(1)).toBe(replacement);
    expect((service as any).activeRuns.get(1)).toBe(run);
    expect(run.resolveCompletion).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    (service as any).activeRuns.delete(1);
    await service.onModuleDestroy();
  });

  it('keeps socket ownership across cleanup and only schedules idle shutdown after the last tab detaches', async () => {
    jest.useRealTimers();
    const { service } = createService();
    mockSpawn.mockImplementation(() => createPiProcess('/tmp/pi-session.jsonl') as never);
    service.onClientAttached(1);
    service.onClientAttached(1);
    await (service as any).ensureRuntime(1);
    await service.cleanupSession(1);
    await (service as any).ensureRuntime(1);
    const entry = (service as any).runtimes.get(1);
    expect(entry.attachedClients).toBe(2);
    service.onClientDetached(1);
    expect(entry.attachedClients).toBe(1);
    expect(entry.idleTimer).toBeNull();
    service.onClientDetached(1);
    expect(entry.attachedClients).toBe(0);
    expect(entry.idleTimer).not.toBeNull();
    expect((service as any).clientCounts.has(1)).toBe(false);
    await service.onModuleDestroy();
  });

  it('publishes first-run native context records before a run is registered and clears unknown post-compaction usage', async () => {
    const { service } = createService();
    const child = createPiProcess('/tmp/pi-session.jsonl');
    mockSpawn.mockReturnValue(child as never);
    await (service as any).ensureRuntime(1);
    const states: any[] = [];
    service.on('event', (event: any) => {
      if (event.type === 'run_state') states.push(event.payload);
    });
    const sendContext = (
      tokens: number | null,
      contextWindow = 200_000,
      apiUsage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      },
    ) =>
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'extension_ui_request',
            id: 'ctx',
            method: 'setStatus',
            statusKey: 'elevenex_context_usage',
            statusText: JSON.stringify({
              model: 'anthropic/sonnet',
              usage: { tokens, contextWindow, percent: 99 },
              apiUsage,
            }),
          }) + '\n',
        ),
      );
    sendContext(50_000);
    expect(states.at(-1).contextUsage).toMatchObject({
      percentage: 25,
      totalTokens: 50_000,
      maxTokens: 200_000,
    });
    expect(states.at(-1).contextUsage.tokenBreakdownAvailable).toBe(false);
    sendContext(100_000, 1_000_000, {
      input: 10_000,
      output: 5_000,
      cacheRead: 80_000,
      cacheWrite: 5_000,
    });
    expect(states.at(-1).contextUsage).toMatchObject({
      percentage: 10,
      inputTokens: 95_000,
      outputTokens: 5_000,
      cacheReadInputTokens: 80_000,
      cacheCreationInputTokens: 5_000,
      tokenBreakdownAvailable: true,
    });
    sendContext(null);
    expect(states.at(-1).contextUsage).toBeNull();
    await service.cleanupSession(1);
    const count = states.length;
    sendContext(150_000);
    expect(states).toHaveLength(count);
    await service.onModuleDestroy();
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

  it('rewinds before a selected Pi user message into a new session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-rewind-'));
    try {
      const sessionPath = join(root, 'session.jsonl');
      await writeFile(
        sessionPath,
        [
          JSON.stringify({ type: 'session', version: 3 }),
          JSON.stringify({
            id: 'first-user',
            type: 'message',
            message: {
              role: 'user',
              timestamp: Date.parse('2026-05-22T10:00:00.000Z'),
              content: [{ type: 'text', text: 'first' }],
            },
          }),
          JSON.stringify({
            id: 'first-assistant',
            type: 'message',
            message: {
              role: 'assistant',
              timestamp: Date.parse('2026-05-22T10:01:00.000Z'),
              content: [{ type: 'text', text: 'done' }],
            },
          }),
          JSON.stringify({
            id: 'edit-user',
            type: 'message',
            message: {
              role: 'user',
              timestamp: Date.parse('2026-05-22T10:02:00.000Z'),
              content: [{ type: 'text', text: 'edit this' }],
            },
          }),
          JSON.stringify({
            id: 'old-assistant',
            type: 'message',
            message: {
              role: 'assistant',
              timestamp: Date.parse('2026-05-22T10:03:00.000Z'),
              content: [{ type: 'text', text: 'old answer' }],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      const child = createPiProcess(sessionPath);
      mockSpawn.mockReturnValue(child as never);
      const { service, sessions } = createService({
        piSessionPath: sessionPath,
      });

      const beforeRewind = await service.getHistory(1);
      const editMessageId = beforeRewind.find(
        (item) => item.content === 'edit this',
      )?.sourceMessageId;
      expect(editMessageId).toBe('edit-user');
      await service.getRuntimeState(1);
      await (service as any).ensureRuntime(1);
      const history = await service.rewindConversation(1, editMessageId!);

      expect(history.map((item) => item.content)).toEqual(['first', 'done']);
      expect(sessions.updatePiSessionPath).toHaveBeenCalledWith(
        1,
        expect.stringContaining('-fork-'),
      );
      const rewoundPath = sessions.updatePiSessionPath.mock.calls[0]?.[1];
      const raw = await readFile(rewoundPath!, 'utf8');
      expect(raw).toContain('first-assistant');
      expect(raw).not.toContain('edit this');
      expect(raw).not.toContain('old answer');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect((await service.getRuntimeState(1)).liveItems).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears the Pi session path when rewinding its first user message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-rewind-first-'));
    try {
      const sessionPath = join(root, 'session.jsonl');
      await writeFile(
        sessionPath,
        JSON.stringify({
          id: 'first-user',
          type: 'message',
          message: {
            role: 'user',
            timestamp: Date.parse('2026-05-22T10:00:00.000Z'),
            content: [{ type: 'text', text: 'start over' }],
          },
        }) + '\n',
        'utf8',
      );
      const { service, sessions } = createService({
        piSessionPath: sessionPath,
      });

      await expect(
        service.rewindConversation(1, 'first-user'),
      ).resolves.toEqual([]);
      expect(sessions.updatePiSessionPath).toHaveBeenCalledWith(1, '-1');
      expect((await service.getRuntimeState(1)).claudeSessionId).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects Pi rewinds while a run is active', async () => {
    const { service, sessions } = createService({
      piSessionPath: '/tmp/pi-session.jsonl',
    });
    (service as any).activeRuns.set(1, {});

    await expect(service.rewindConversation(1, 'user-entry')).rejects.toThrow(
      'Cannot edit a message while Pi is actively running.',
    );
    expect(sessions.updatePiSessionPath).not.toHaveBeenCalled();
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

  it('honors a stop requested during cold initialization and pauses queued prompts', async () => {
    const child = createPiProcess('/tmp/pi-session-1.jsonl');
    mockSpawn.mockReturnValue(child as never);
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envStarted = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementationOnce(() => {
      envStarted.resolve();
      return env.promise;
    });
    const { service } = createService({ idleMs: '60000' });
    const first = service.submitPrompt(1, 'first');
    await envStarted.promise;
    await service.interrupt(1);
    await service.submitPrompt(1, 'second');
    env.resolve({ PATH: '/mock/bin' });
    await first;
    expect(child.stdin.writes.map((write) => JSON.parse(write)).filter((command) => command.type === 'prompt')).toEqual([]);
    expect(await service.getRuntimeState(1)).toMatchObject({
      runPhase: 'idle',
      queuePaused: true,
      pendingPrompts: [expect.objectContaining({ prompt: 'second' })],
    });
    await service.onModuleDestroy();
  });

  it('queues prompts submitted while the Pi run is still initializing', async () => {
    const child = createPiProcess('/tmp/pi-session-1.jsonl');
    mockSpawn.mockReturnValue(child as never);
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envStarted = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementationOnce(() => {
      envStarted.resolve();
      return env.promise;
    });
    const { service } = createService({ idleMs: '60000' });

    const firstPrompt = service.submitPrompt(1, 'first');
    await envStarted.promise;

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
