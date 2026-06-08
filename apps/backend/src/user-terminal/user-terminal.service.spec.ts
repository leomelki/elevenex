import { promises as fs } from 'fs';
import { UserTerminalService } from './user-terminal.service.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('UserTerminalService', () => {
  let service: UserTerminalService;
  let ptyManager: {
    destroy: jest.Mock;
    isAlive: jest.Mock;
    spawn: jest.Mock;
  };

  beforeEach(() => {
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);

    ptyManager = {
      destroy: jest.fn(),
      isAlive: jest.fn(),
      spawn: jest.fn(),
    };

    service = new UserTerminalService({} as never, ptyManager as never);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 3,
      worktreePath: process.cwd(),
      shell: '/bin/zsh',
      name: 'zsh',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuses an already running terminal without spawning again', async () => {
    ptyManager.isAlive.mockReturnValue(true);

    const result = await service.startTerminal(3);

    expect(result).toEqual({ success: true });
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('does not report success when async terminal spawn was cancelled', async () => {
    ptyManager.isAlive.mockReturnValue(false);
    ptyManager.spawn.mockResolvedValue(null);

    const result = await service.startTerminal(3);

    expect(ptyManager.spawn).toHaveBeenCalledWith(3, process.cwd(), '/bin/zsh');
    expect(result).toEqual({
      success: false,
      error: 'Terminal start was cancelled',
    });
  });

  it('coalesces concurrent starts for the same terminal', async () => {
    const access = createDeferred<void>();
    jest.spyOn(fs, 'access').mockReturnValue(access.promise);
    ptyManager.isAlive.mockReturnValue(false);
    ptyManager.spawn.mockResolvedValue({});

    const firstStart = service.startTerminal(3);
    const secondStart = service.startTerminal(3);

    access.resolve();

    await expect(Promise.all([firstStart, secondStart])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
    expect(service.findOne).toHaveBeenCalledTimes(1);
    expect(ptyManager.spawn).toHaveBeenCalledTimes(1);
  });
});
