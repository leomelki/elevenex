import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { UserPtyManager } from './user-pty-manager.service.js';
import {
  buildAugmentedEnvAsync,
  findBinary,
  normalizeShellForPlatform,
  stripInheritedTmuxEnv,
} from '../config/system-paths.js';
import { execFileQuiet } from '../terminal/async-process.js';
import { shouldUseTmux } from '../config/backend-runtime-mode.js';

jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(),
  findBinary: jest.fn(() => null),
  normalizeShellForPlatform: jest.fn((shell: string) => shell),
  stripInheritedTmuxEnv: jest.fn((env: NodeJS.ProcessEnv) => env),
}));

jest.mock('../terminal/async-process.js', () => ({
  execFileQuiet: jest.fn(),
}));

jest.mock('../config/backend-runtime-mode.js', () => ({
  shouldUseTmux: jest.fn(() => true),
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
  const mockNormalizeShellForPlatform = jest.mocked(normalizeShellForPlatform);
  const mockStripInheritedTmuxEnv = jest.mocked(stripInheritedTmuxEnv);
  const mockExecFileQuiet = jest.mocked(execFileQuiet);
  const mockShouldUseTmux = jest.mocked(shouldUseTmux);

  let manager: UserPtyManager;

  beforeEach(() => {
    jest.resetAllMocks();
    mockBuildAugmentedEnv.mockResolvedValue({ PATH: '/mock/bin' });
    mockFindBinary.mockReturnValue(null);
    mockNormalizeShellForPlatform.mockImplementation((shell) => shell);
    mockStripInheritedTmuxEnv.mockImplementation((env) => env);
    mockShouldUseTmux.mockReturnValue(true);
    mockExecFileQuiet.mockResolvedValue(undefined);
    mockSpawn.mockReturnValue(createMockPty() as never);
    manager = new UserPtyManager({
      sendToTerminal: jest.fn(),
    } as never);
  });

  it('does not resolve or invoke tmux when the backend is local', async () => {
    mockShouldUseTmux.mockReturnValue(false);
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    mockFindBinary.mockClear();
    manager = new UserPtyManager({
      sendToTerminal: jest.fn(),
    } as never);

    await manager.spawn(4, '/repo/worktree', '/bin/zsh');

    expect(mockFindBinary).not.toHaveBeenCalled();
    expect(mockExecFileQuiet).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/zsh',
      [],
      expect.objectContaining({ cwd: '/repo/worktree' }),
    );
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
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(process.resize).toHaveBeenNthCalledWith(1, 100, 20);
    expect(process.resize).toHaveBeenNthCalledWith(2, 120, 30);
    expect(mockExecFileQuiet).toHaveBeenCalledTimes(2);

    firstResize.resolve();
    await firstResize.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockExecFileQuiet.mock.calls.map((call) => call[1])).toEqual([
      ['set-option', '-t', 'elevenex-uterm-3', 'window-size', 'latest'],
      ['set-option', '-t', 'elevenex-uterm-3', 'default-size', '100x20'],
      ['set-option', '-t', 'elevenex-uterm-3', 'window-size', 'latest'],
      ['set-option', '-t', 'elevenex-uterm-3', 'default-size', '120x30'],
    ]);
  });
  it('keeps a direct PTY alive on UI detach and replays output produced while hidden', async () => {
    mockShouldUseTmux.mockReturnValue(false);
    const gateway = { sendToTerminal: jest.fn() };
    manager = new UserPtyManager(gateway as never);
    const process = (await manager.spawn(
      3,
      '/repo/worktree',
      '/bin/zsh',
    )) as unknown as MockPty;
    const onData = process.onData.mock.calls[0][0] as (data: string) => void;
    onData('before hiding\r\n');
    manager.detach(3);
    onData('while hidden\r\n');
    manager.replayOutput(3);

    expect(process.kill).not.toHaveBeenCalled();
    expect(manager.isAlive(3)).toBe(true);
    expect(gateway.sendToTerminal).toHaveBeenLastCalledWith(
      3,
      '\x1bcbefore hiding\r\nwhile hidden\r\n',
    );
    manager.write(3, 'echo still-alive\r');
    expect(process.write).toHaveBeenCalledWith('echo still-alive\r');
  });

  it('allows a local terminal to finish starting after the UI detaches', async () => {
    mockShouldUseTmux.mockReturnValue(false);
    const gateway = { sendToTerminal: jest.fn() };
    manager = new UserPtyManager(gateway as never);
    const env = createDeferred<NodeJS.ProcessEnv>();
    mockBuildAugmentedEnv.mockReturnValue(env.promise);
    const spawn = manager.spawn(3, '/repo/worktree', '/bin/zsh');
    manager.detach(3);
    env.resolve({ PATH: '/mock/bin' });

    await expect(spawn).resolves.not.toBeNull();
    expect(manager.isAlive(3)).toBe(true);
  });

  it('kills retained local PTYs and discards replay output on backend shutdown', async () => {
    jest.useFakeTimers();
    try {
      mockShouldUseTmux.mockReturnValue(false);
      const gateway = { sendToTerminal: jest.fn() };
      manager = new UserPtyManager(gateway as never);
      const process = (await manager.spawn(
        3,
        '/repo/worktree',
        '/bin/zsh',
      )) as unknown as MockPty;
      process.onData.mock.calls[0][0]('retained output');
      manager.detach(3);
      manager.onApplicationShutdown();
      gateway.sendToTerminal.mockClear();
      manager.replayOutput(3);

      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(manager.isAlive(3)).toBe(false);
      expect(gateway.sendToTerminal).not.toHaveBeenCalled();
      await expect(
        manager.spawn(3, '/repo/worktree', '/bin/zsh'),
      ).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels pending local spawns when the backend shuts down', async () => {
    mockShouldUseTmux.mockReturnValue(false);
    const gateway = { sendToTerminal: jest.fn() };
    manager = new UserPtyManager(gateway as never);
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envRequested = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementation(() => {
      envRequested.resolve();
      return env.promise;
    });
    const spawn = manager.spawn(3, '/repo/worktree', '/bin/zsh');
    await envRequested.promise;
    manager.onModuleDestroy();
    env.resolve({ PATH: '/mock/bin' });

    await expect(spawn).resolves.toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('still detaches remote tmux attachments when the UI disconnects', async () => {
    jest.useFakeTimers();
    try {
      mockFindBinary.mockReturnValue('/usr/bin/tmux');
      manager = new UserPtyManager({ sendToTerminal: jest.fn() } as never);
      const process = (await manager.spawn(
        3,
        '/repo/worktree',
        '/bin/zsh',
      )) as unknown as MockPty;
      manager.detach(3);

      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(manager.isAlive(3)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
