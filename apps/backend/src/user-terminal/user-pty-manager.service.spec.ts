import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { UserPtyManager } from './user-pty-manager.service.js';
import { buildAugmentedEnvAsync, findBinary } from '../config/system-paths.js';
import { execFileQuiet } from '../terminal/async-process.js';

jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(),
  findBinary: jest.fn(() => null),
}));

jest.mock('../terminal/async-process.js', () => ({
  execFileQuiet: jest.fn(),
}));

type MockPty = EventEmitter & {
  kill: jest.Mock;
  onData: jest.Mock;
  onExit: jest.Mock;
  pid: number;
  resize: jest.Mock;
  write: jest.Mock;
};

function createMockPty(): MockPty {
  const process = new EventEmitter() as MockPty;
  process.kill = jest.fn();
  process.onData = jest.fn();
  process.onExit = jest.fn();
  process.pid = 123;
  process.resize = jest.fn();
  process.write = jest.fn();
  return process;
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

describe('UserPtyManager', () => {
  const mockSpawn = jest.mocked(pty.spawn);
  const mockBuildAugmentedEnv = jest.mocked(buildAugmentedEnvAsync);
  const mockFindBinary = jest.mocked(findBinary);
  const mockExecFileQuiet = jest.mocked(execFileQuiet);

  let manager: UserPtyManager;

  beforeEach(() => {
    jest.resetAllMocks();
    mockBuildAugmentedEnv.mockResolvedValue({ PATH: '/mock/bin' });
    mockFindBinary.mockReturnValue(null);
    mockExecFileQuiet.mockResolvedValue(undefined);
    mockSpawn.mockReturnValue(createMockPty() as never);
    manager = new UserPtyManager({
      sendToTerminal: jest.fn(),
    } as never);
  });

  it('coalesces concurrent async spawns for the same terminal', async () => {
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envRequested = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementation(() => {
      envRequested.resolve();
      return env.promise;
    });

    const firstSpawn = manager.spawn(3, '/repo/worktree', '/bin/zsh');
    const secondSpawn = manager.spawn(3, '/repo/worktree', '/bin/zsh');
    await envRequested.promise;

    env.resolve({ PATH: '/mock/bin' });
    await Promise.all([firstSpawn, secondSpawn]);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight spawn before any terminal PTY starts', async () => {
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envRequested = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementation(() => {
      envRequested.resolve();
      return env.promise;
    });

    const spawnPromise = manager.spawn(3, '/repo/worktree', '/bin/zsh');
    await envRequested.promise;

    expect(manager.kill(3)).toBe(true);
    env.resolve({ PATH: '/mock/bin' });

    await expect(spawnPromise).resolves.toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ignores stale exit events from a replaced terminal PTY process', async () => {
    jest.useFakeTimers();
    let nextPid = 200;
    mockSpawn.mockImplementation(() => {
      const process = createMockPty();
      process.pid = nextPid++;
      return process as never;
    });

    try {
      const first = await manager.spawn(3, '/repo/worktree', '/bin/zsh');
      expect(first).not.toBeNull();
      manager.kill(3);
      const second = await manager.spawn(3, '/repo/worktree', '/bin/zsh');
      expect(second).not.toBeNull();

      (first as MockPty).onExit.mock.calls[0][0]({
        exitCode: 0,
        signal: undefined,
      });

      expect(manager.isAlive(3)).toBe(true);

      (second as MockPty).onExit.mock.calls[0][0]({
        exitCode: 0,
        signal: undefined,
      });

      expect(manager.isAlive(3)).toBe(false);
      jest.advanceTimersByTime(5000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('serializes tmux resizes so the latest frontend size wins', async () => {
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    manager = new UserPtyManager({
      sendToTerminal: jest.fn(),
    } as never);

    const firstResize = createDeferred<void>();
    mockExecFileQuiet.mockImplementation((_file, args) => {
      if (args.includes('100x20')) {
        return firstResize.promise;
      }
      return Promise.resolve();
    });

    const process = createMockPty();
    (
      manager as unknown as {
        processes: Map<
          number,
          {
            pty: MockPty;
            terminalId: number;
            tmuxSessionName: string;
            pid: number;
            useTmux: boolean;
          }
        >;
      }
    ).processes.set(3, {
      pty: process,
      terminalId: 3,
      tmuxSessionName: 'elevenex-uterm-3',
      pid: process.pid,
      useTmux: true,
    });

    manager.resize(3, 100, 20);
    manager.resize(3, 120, 30);

    expect(process.resize).toHaveBeenNthCalledWith(1, 100, 20);
    expect(process.resize).toHaveBeenNthCalledWith(2, 120, 30);
    expect(mockExecFileQuiet).toHaveBeenCalledTimes(1);

    firstResize.resolve();
    await firstResize.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockExecFileQuiet.mock.calls.map((call) => call[1])).toEqual([
      [
        'set-option',
        '-t',
        'elevenex-uterm-3',
        'default-size',
        '100x20',
      ],
      ['resize-window', '-t', 'elevenex-uterm-3', '100', '20'],
      [
        'set-option',
        '-t',
        'elevenex-uterm-3',
        'default-size',
        '120x30',
      ],
      ['resize-window', '-t', 'elevenex-uterm-3', '120', '30'],
    ]);
  });
});
