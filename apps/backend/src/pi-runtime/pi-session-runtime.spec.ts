import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PiSessionRuntime } from './pi-session-runtime.js';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(async () => ({ PATH: '/mock/bin' })),
}));

class MockWritable extends EventEmitter {
  writable = true;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
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

function createPiProcess(): MockPiProcess {
  const child = new EventEmitter() as MockPiProcess;
  child.stdin = new MockWritable();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.pid = 1234;
  child.kill = jest.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM') {
      child.killed = true;
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    }
    return true;
  });
  return child;
}

function flushAsyncStart(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('PiSessionRuntime', () => {
  let child: MockPiProcess;

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockBuildAugmentedEnv.mockResolvedValue({ PATH: '/mock/bin' });
    child = createPiProcess();
    mockSpawn.mockReturnValue(child as never);
  });

  it('spawns pi rpc in the worktree and correlates JSONL responses', async () => {
    const runtime = new PiSessionRuntime({ cwd: '/repo/worktree' });

    const resultPromise = runtime.send<{ sessionFile: string }>({
      type: 'get_state',
    });
    await flushAsyncStart();

    expect(mockSpawn).toHaveBeenCalledWith('pi', ['--mode', 'rpc'], {
      cwd: '/repo/worktree',
      env: { PATH: '/mock/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(child.stdin.writes).toEqual(['{"type":"get_state","id":"pi-1"}\n']);

    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"response","id":"pi-1","success":true,"data":{"sessionFile":"/tmp/pi-session.jsonl"}}\n',
      ),
    );

    await expect(resultPromise).resolves.toEqual({
      sessionFile: '/tmp/pi-session.jsonl',
    });
  });

  it('resumes with an existing Pi session file', async () => {
    const runtime = new PiSessionRuntime({
      cwd: '/repo/worktree',
      sessionPath: '/Users/test/.pi/agent/sessions/session.jsonl',
    });

    await runtime.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      'pi',
      [
        '--mode',
        'rpc',
        '--session',
        '/Users/test/.pi/agent/sessions/session.jsonl',
      ],
      expect.objectContaining({ cwd: '/repo/worktree' }),
    );
  });

  it('coalesces concurrent async starts into one Pi process', async () => {
    const env = createDeferred<NodeJS.ProcessEnv>();
    mockBuildAugmentedEnv.mockReturnValueOnce(env.promise);
    const runtime = new PiSessionRuntime({ cwd: '/repo/worktree' });

    const firstStart = runtime.start();
    const secondStart = runtime.start();

    expect(mockBuildAugmentedEnv).toHaveBeenCalledTimes(1);
    env.resolve({ PATH: '/mock/bin' });
    await Promise.all([firstStart, secondStart]);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('routes extension UI requests and responses without command correlation', async () => {
    const runtime = new PiSessionRuntime({ cwd: '/repo/worktree' });
    const requests: unknown[] = [];
    runtime.on('extension_ui_request', (request) => requests.push(request));

    await runtime.start();
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"extension_ui_request","id":"ui-1","kind":"select","prompt":"Pick","options":["a"]}\n',
      ),
    );
    runtime.respondToExtensionUi({
      type: 'extension_ui_response',
      id: 'ui-1',
      value: 'a',
    });

    expect(requests).toEqual([
      {
        type: 'extension_ui_request',
        id: 'ui-1',
        kind: 'select',
        prompt: 'Pick',
        options: ['a'],
      },
    ]);
    expect(child.stdin.writes.at(-1)).toBe(
      '{"type":"extension_ui_response","id":"ui-1","value":"a"}\n',
    );
  });

  it('rejects pending RPC commands when the Pi process exits unexpectedly', async () => {
    const runtime = new PiSessionRuntime({ cwd: '/repo/worktree' });

    const resultPromise = runtime.send({ type: 'prompt', prompt: 'hello' });
    await flushAsyncStart();
    child.emit('exit', 1, null);

    await expect(resultPromise).rejects.toThrow(
      'Pi RPC process exited with code 1',
    );
  });
});
