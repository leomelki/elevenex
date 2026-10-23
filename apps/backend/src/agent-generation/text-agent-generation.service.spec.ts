import {
  readCodexExecAgentMessage,
  readCodexExecError,
  TextAgentGenerationService,
} from './text-agent-generation.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { PiSessionRuntime } from '../pi-runtime/pi-session-runtime.js';
import childProcess from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import * as systemPaths from '../config/system-paths.js';
import * as codexBinary from '../codex-runtime/codex-binary.js';
import { OpenCodeServer } from '../opencode-runtime/opencode-server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('TextAgentGenerationService lifetime', () => {
  let service: TextAgentGenerationService;
  const request = {
    worktreePath: '/repo',
    prompt: 'Generate text',
    taskName: 'test',
  };
  let spawn: jest.SpyInstance;
  let env: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new TextAgentGenerationService({
      getAgentProviderDefaults: () => ({ model: null }),
    } as unknown as SettingsService);
    spawn = jest.spyOn(childProcess, 'spawn');
    env = jest
      .spyOn(systemPaths, 'buildAugmentedEnvAsync')
      .mockResolvedValue({});
    jest
      .spyOn(systemPaths, 'buildSpawnCommand')
      .mockReturnValue({ command: 'codex', shell: false });
    jest.spyOn(codexBinary, 'resolveCodexBinary').mockReturnValue('codex');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function child() {
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
      exitCode: null,
    });
    spawn.mockReturnValue(process);
    return process;
  }

  it.each(['claude', 'codex', 'pi', 'opencode'] as const)(
    'does not start an already aborted %s request',
    async (provider) => {
      const controller = new AbortController();
      controller.abort();
      const sdk = jest.spyOn(service as any, 'loadClaudeSdk');
      const send = jest.spyOn(PiSessionRuntime.prototype, 'send');
      const start = jest.spyOn(OpenCodeServer.prototype, 'start');
      await expect(
        service.generate({ ...request, provider, signal: controller.signal }),
      ).resolves.toBeNull();
      expect(sdk).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('bounds deferred Claude SDK loading with the default deadline and ignores late startup', async () => {
    const sdk = deferred<any>();
    const query = jest.fn();
    jest.spyOn(service as any, 'loadClaudeSdk').mockReturnValue(sdk.promise);
    const pending = service.generate({ ...request, provider: 'claude' });
    await jest.advanceTimersByTimeAsync(59_999);
    expect(query).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    sdk.resolve({ query });
    await jest.advanceTimersByTimeAsync(0);
    expect(query).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['claude', 'codex'] as const)(
    'does not launch %s after cancellation during environment startup',
    async (provider) => {
      const startup = deferred<NodeJS.ProcessEnv>();
      env.mockReturnValue(startup.promise);
      const query = jest.fn();
      jest.spyOn(service as any, 'loadClaudeSdk').mockResolvedValue({ query });
      const controller = new AbortController();
      const pending = service.generate({
        ...request,
        provider,
        signal: controller.signal,
      });
      await jest.advanceTimersByTimeAsync(0);
      controller.abort();
      await expect(pending).resolves.toBeNull();
      startup.resolve({});
      await jest.advanceTimersByTimeAsync(0);
      expect(query).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['timeout', 'abort'] as const)(
    'closes a hanging Claude query on %s',
    async (reason) => {
      const next = deferred<any>();
      const close = jest.fn();
      const query = jest.fn((_options: any) => ({
        [Symbol.asyncIterator]: () => ({ next: () => next.promise }),
        close,
      }));
      jest.spyOn(service as any, 'loadClaudeSdk').mockResolvedValue({ query });
      const controller = new AbortController();
      const pending = service.generate({
        ...request,
        provider: 'claude',
        timeoutMs: 25,
        signal: controller.signal,
      });
      await jest.advanceTimersByTimeAsync(0);
      if (reason === 'abort') controller.abort();
      else await jest.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeNull();
      expect(
        query.mock.calls[0][0].options.abortController.signal.aborted,
      ).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      next.reject(new Error('Late SDK rejection'));
      await jest.advanceTimersByTimeAsync(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('keeps successful Claude output and closes the SDK query', async () => {
    const close = jest.fn();
    jest.spyOn(service as any, 'loadClaudeSdk').mockResolvedValue({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Safe title' }] },
          };
          yield { type: 'result' };
        },
        close,
      }),
    });
    await expect(
      service.generate({ ...request, provider: 'claude' }),
    ).resolves.toMatchObject({ text: 'Safe title' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for Codex close and consumes trailing stdout without a newline after exit', async () => {
    const process = child();
    const controller = new AbortController();
    const pending = service.generate({
      ...request,
      provider: 'codex',
      signal: controller.signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    process.emit('exit', 0, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    process.stdout.end(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Final response' },
      }),
    );
    process.stderr.end();
    await jest.advanceTimersByTimeAsync(0);
    process.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ text: 'Final response' });
    expect(process.listenerCount('close')).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(process.kill).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves safe fallback for trailing Codex protocol errors', async () => {
    const process = child();
    const pending = service.generate({ ...request, provider: 'codex' });
    await jest.advanceTimersByTimeAsync(0);
    process.emit('exit', 1, null);
    process.stdout.end(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Auth failed' },
      }),
    );
    await jest.advanceTimersByTimeAsync(0);
    process.emit('close', 1, null);
    await expect(pending).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'timeout',
    'abort',
    'error',
    'stdin-error',
    'stdout-error',
  ] as const)(
    'terminates Codex and releases resources on %s',
    async (reason) => {
      const process = child();
      const controller = new AbortController();
      const pending = service.generate({
        ...request,
        provider: 'codex',
        timeoutMs: 25,
        signal: controller.signal,
      });
      await jest.advanceTimersByTimeAsync(0);
      if (reason === 'abort') controller.abort();
      else if (reason === 'error')
        process.emit('error', new Error('spawn failed'));
      else if (reason === 'stdin-error')
        process.stdin.emit('error', new Error('EPIPE'));
      else if (reason === 'stdout-error')
        process.stdout.emit('error', new Error('read failed'));
      else await jest.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeNull();
      expect(process.kill).toHaveBeenCalledWith('SIGTERM');
      expect(() =>
        process.stdin.emit('error', new Error('late EPIPE')),
      ).not.toThrow();
      process.emit('close', null, 'SIGTERM');
      expect(process.eventNames()).toHaveLength(0);
      expect(process.stdin.listenerCount('error')).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('escalates Codex termination when the child never closes', async () => {
    const process = child();
    const pending = service.generate({
      ...request,
      provider: 'codex',
      timeoutMs: 25,
    });
    await jest.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBeNull();
    await jest.advanceTimersByTimeAsync(1500);
    expect(process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(process.stdin.destroyed).toBe(true);
    expect(process.stdout.destroyed).toBe(true);
    expect(process.stderr.destroyed).toBe(true);
    expect(process.eventNames()).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['error', 'exit', 'timeout', 'abort'] as const)(
    'handles Pi %s while send and stop remain pending',
    async (reason) => {
      const startup = deferred<any>();
      let runtime!: PiSessionRuntime;
      jest
        .spyOn(PiSessionRuntime.prototype, 'send')
        .mockImplementation(function (this: PiSessionRuntime) {
          runtime = this;
          return startup.promise;
        });
      const stop = jest
        .spyOn(PiSessionRuntime.prototype, 'stop')
        .mockReturnValue(new Promise(() => {}));
      const controller = new AbortController();
      const pending = service.generate({
        ...request,
        provider: 'pi',
        timeoutMs: 25,
        signal: controller.signal,
      });
      if (reason === 'error')
        runtime.emit('event', {
          type: 'error',
          message: 'failed before RPC ack',
        });
      else if (reason === 'exit')
        runtime.emit('exit', { message: 'early exit' });
      else if (reason === 'abort') controller.abort();
      await jest.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeNull();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(runtime.eventNames()).toHaveLength(0);
      startup.reject(new Error('Late RPC failure'));
      await jest.advanceTimersByTimeAsync(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('does not send a late Pi prompt after an early failure during model selection', async () => {
    const selection = deferred<any>();
    let runtime!: PiSessionRuntime;
    const send = jest
      .spyOn(PiSessionRuntime.prototype, 'send')
      .mockImplementation(function (this: PiSessionRuntime) {
        runtime = this;
        return selection.promise;
      });
    jest.spyOn(PiSessionRuntime.prototype, 'stop').mockResolvedValue();
    const pending = service.generate({
      ...request,
      provider: 'pi',
      pi: { model: 'provider/model' },
    });
    runtime.emit('event', { type: 'error', message: 'Early failure' });
    await expect(pending).resolves.toBeNull();
    selection.resolve(undefined);
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.eventNames()).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels OpenCode during startup and observes a late startup rejection', async () => {
    const startup = deferred<any>();
    jest
      .spyOn(OpenCodeServer.prototype, 'start')
      .mockReturnValue(startup.promise);
    const close = jest
      .spyOn(OpenCodeServer.prototype, 'close')
      .mockImplementation(() => {});
    const controller = new AbortController();
    const pending = service.generate({
      ...request,
      provider: 'opencode',
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    startup.reject(new Error('Late startup failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['startup', 'create', 'prompt', 'delete'] as const)(
    'bounds OpenCode %s and closes its server',
    async (stage) => {
      const deferredStage = deferred<any>();
      const client = {
        session: {
          create: jest.fn().mockResolvedValue({ data: { id: 'session' } }),
          prompt: jest.fn().mockResolvedValue({
            data: { info: {}, parts: [{ type: 'text', text: 'Result' }] },
          }),
          delete: jest.fn().mockResolvedValue({}),
        },
      };
      const start = jest
        .spyOn(OpenCodeServer.prototype, 'start')
        .mockResolvedValue(client as any);
      const close = jest
        .spyOn(OpenCodeServer.prototype, 'close')
        .mockImplementation(() => {});
      if (stage === 'startup') start.mockReturnValue(deferredStage.promise);
      else client.session[stage].mockReturnValue(deferredStage.promise);
      const controller = new AbortController();
      const pending = service.generate({
        ...request,
        provider: 'opencode',
        timeoutMs: 25,
        signal: controller.signal,
      });
      await jest.advanceTimersByTimeAsync(25);
      if (stage === 'delete') {
        await expect(pending).resolves.toMatchObject({ text: 'Result' });
      } else {
        await expect(pending).resolves.toBeNull();
      }
      expect(close).toHaveBeenCalledTimes(1);
      deferredStage.resolve(
        stage === 'startup' ? client : { data: { id: 'session' } },
      );
      await jest.advanceTimersByTimeAsync(0);
      if (stage === 'startup')
        expect(client.session.create).not.toHaveBeenCalled();
      if (stage === 'create')
        expect(client.session.prompt).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});

describe('TextAgentGenerationService model selection', () => {
  const getAgentProviderDefaults = jest.fn((provider: string) => ({
    model: `${provider}-user-default`,
    reasoningEffort: 'high',
  }));
  const service = new TextAgentGenerationService({
    getAgentProviderDefaults,
  } as unknown as SettingsService);

  beforeEach(() => {
    getAgentProviderDefaults.mockImplementation((provider: string) => ({
      model: `${provider}-user-default`,
      reasoningEffort: 'high',
    }));
  });

  it('uses the model selected by the user', () => {
    expect((service as any).resolveModel('codex')).toBe('codex-user-default');
    expect((service as any).resolveModel('pi')).toBe('pi-user-default');
  });

  it('defers to the provider when the user has not selected a model', () => {
    getAgentProviderDefaults.mockReturnValueOnce({
      model: null,
      reasoningEffort: null,
    });

    expect((service as any).resolveModel('codex')).toBeNull();
  });

  it('keeps an explicit model override', () => {
    expect((service as any).resolveModel('codex', 'temporary-model')).toBe(
      'temporary-model',
    );
  });

  it('selects the user default model and low reasoning for Pi one-shot tasks', async () => {
    getAgentProviderDefaults.mockReturnValueOnce({
      model: 'provider/user-selected-pi-model',
      reasoningEffort: 'high',
    });
    const send = jest
      .spyOn(PiSessionRuntime.prototype, 'send')
      .mockImplementation(function (this: PiSessionRuntime, command: any) {
        if (command.type === 'prompt') {
          setImmediate(() => this.emit('event', { type: 'agent_end' }));
        }
        return Promise.resolve(undefined as never);
      });
    const stop = jest
      .spyOn(PiSessionRuntime.prototype, 'stop')
      .mockResolvedValue();

    await service.generate({
      provider: 'pi',
      worktreePath: '/repo',
      prompt: 'Generate text',
      taskName: 'test',
    });

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'set_model',
      provider: 'provider',
      modelId: 'user-selected-pi-model',
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'prompt',
      message: 'Generate text',
      reasoningEffort: 'low',
    });
    stop.mockRestore();
    send.mockRestore();
  });
});

describe('readCodexExecAgentMessage', () => {
  it('extracts completed assistant output from the CLI JSONL stream', () => {
    expect(
      readCodexExecAgentMessage(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Generated title' },
        }),
      ),
    ).toBe('Generated title');
  });

  it('ignores other events and non-JSON diagnostic output', () => {
    expect(
      readCodexExecAgentMessage(JSON.stringify({ type: 'turn.completed' })),
    ).toBeNull();
    expect(readCodexExecAgentMessage('warning: retrying')).toBeNull();
  });
});

describe('readCodexExecError', () => {
  it('extracts top-level and failed-turn errors from the CLI JSONL stream', () => {
    expect(
      readCodexExecError(
        JSON.stringify({ type: 'error', message: 'Authentication failed' }),
      ),
    ).toBe('Authentication failed');
    expect(
      readCodexExecError(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'Model unavailable' },
        }),
      ),
    ).toBe('Model unavailable');
  });

  it('ignores unrelated and malformed lines', () => {
    expect(
      readCodexExecError(JSON.stringify({ type: 'turn.started' })),
    ).toBeNull();
    expect(readCodexExecError('not json')).toBeNull();
  });
});
