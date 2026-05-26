import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { UserPtyManager } from './user-pty-manager.service.js';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';

jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(),
  findBinary: jest.fn(() => null),
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

  let manager: UserPtyManager;

  beforeEach(() => {
    jest.resetAllMocks();
    mockBuildAugmentedEnv.mockResolvedValue({ PATH: '/mock/bin' });
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
});
