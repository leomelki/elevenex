import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { PtyManager } from './pty-manager.service.js';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';

jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(),
  buildTmuxInlineEnvPrefix: jest.fn(() => "PATH='/mock/bin'"),
  findBinary: jest.fn(() => null),
}));

jest.mock('../config/runtime-paths.js', () => ({
  getBackendHelperPath: jest.fn(() => '/tmp/plannotator-wrapper.sh'),
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

describe('PtyManager', () => {
  const mockSpawn = jest.mocked(pty.spawn);
  const mockBuildAugmentedEnv = jest.mocked(buildAugmentedEnvAsync);

  let manager: PtyManager;
  let gateway: {
    sendToSession: jest.Mock;
    onUnexpectedExit: jest.Mock;
  };
  let tmuxManager: {
    isTmuxAvailable: jest.Mock;
    sessionExists: jest.Mock;
    getTmuxBin: jest.Mock;
    configureScrollBindings: jest.Mock;
    killSession: jest.Mock;
  };
  let plannotatorRegistry: {
    registerLaunch: jest.Mock;
    markLaunchInactive: jest.Mock;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    mockBuildAugmentedEnv.mockResolvedValue({ PATH: '/mock/bin' });
    mockSpawn.mockReturnValue(createMockPty() as never);
    tmuxManager = {
      isTmuxAvailable: jest.fn(() => false),
      sessionExists: jest.fn(),
      getTmuxBin: jest.fn(() => '/usr/bin/tmux'),
      configureScrollBindings: jest.fn(),
      killSession: jest.fn(),
    };
    plannotatorRegistry = {
      registerLaunch: jest.fn(),
      markLaunchInactive: jest.fn(),
    };
    gateway = {
      sendToSession: jest.fn(),
      onUnexpectedExit: jest.fn(),
    };
    manager = new PtyManager(
      gateway as never,
      tmuxManager as never,
      plannotatorRegistry as never,
    );
  });

  it('coalesces concurrent async spawns for the same session', async () => {
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envRequested = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementation(() => {
      envRequested.resolve();
      return env.promise;
    });

    const firstSpawn = manager.spawn(7, '/repo/worktree');
    const secondSpawn = manager.spawn(7, '/repo/worktree');
    await envRequested.promise;

    env.resolve({ PATH: '/mock/bin' });
    await Promise.all([firstSpawn, secondSpawn]);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight spawn before any PTY process starts', async () => {
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envRequested = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementation(() => {
      envRequested.resolve();
      return env.promise;
    });

    const spawnPromise = manager.spawn(7, '/repo/worktree');
    await envRequested.promise;

    expect(manager.kill(7)).toBe(true);
    env.resolve({ PATH: '/mock/bin' });

    await expect(spawnPromise).resolves.toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(plannotatorRegistry.markLaunchInactive).toHaveBeenCalledWith(7);
  });

  it('ignores stale exit events from a replaced PTY process', async () => {
    jest.useFakeTimers();
    let nextPid = 100;
    mockSpawn.mockImplementation(() => {
      const process = createMockPty();
      process.pid = nextPid++;
      return process as never;
    });

    try {
      const first = await manager.spawn(7, '/repo/worktree');
      expect(first).not.toBeNull();
      manager.kill(7);
      const second = await manager.spawn(7, '/repo/worktree');
      expect(second).not.toBeNull();

      (first as MockPty).onExit.mock.calls[0][0]({
        exitCode: 0,
        signal: undefined,
      });

      expect(manager.getPid(7)).toBe((second as MockPty).pid);

      (second as MockPty).onExit.mock.calls[0][0]({
        exitCode: 1,
        signal: undefined,
      });

      expect(gateway.onUnexpectedExit).toHaveBeenCalledWith(7, 1, undefined);
      jest.advanceTimersByTime(5000);
    } finally {
      jest.useRealTimers();
    }
  });
});
