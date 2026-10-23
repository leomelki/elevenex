import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { ActionsService } from './actions.service.js';
import { ActionPtyManager } from './action-pty-manager.service.js';
import {
  buildAugmentedEnvAsync,
  buildShellCommandArgs,
  buildTmuxInlineEnvPrefix,
  findBinary,
  getDefaultUserShell,
  normalizeShellForPlatform,
} from '../config/system-paths.js';
import { execFileAsync, execFileQuiet } from '../terminal/async-process.js';
import { shouldUseTmux } from '../config/backend-runtime-mode.js';

jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(),
  buildShellCommandArgs: jest.fn((_shell: string, command: string) => [
    '-lc',
    command,
  ]),
  buildTmuxInlineEnvPrefix: jest.fn(() => "PATH='/repo/bin'"),
  findBinary: jest.fn(),
  getDefaultUserShell: jest.fn(() => '/bin/sh'),
  normalizeShellForPlatform: jest.fn((shell: string) => shell),
}));

jest.mock('../terminal/async-process.js', () => ({
  execFileQuiet: jest.fn(),
  execFileAsync: jest.fn(),
}));

jest.mock('../config/backend-runtime-mode.js', () => ({
  shouldUseTmux: jest.fn(() => true),
}));

type MockPty = EventEmitter & {
  kill: jest.Mock;
  onData: jest.Mock;
  onExit: jest.Mock;
  pid: number;
};

const createdPtys: MockPty[] = [];

function createMockPty(): MockPty {
  const process = new EventEmitter() as MockPty;
  process.kill = jest.fn();
  process.onData = jest.fn();
  process.onExit = jest.fn((callback) => {
    process.on('exit', callback);
    return { dispose: () => process.off('exit', callback) };
  });
  process.pid = 123;
  createdPtys.push(process);
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

describe('ActionPtyManager', () => {
  const mockSpawn = jest.mocked(pty.spawn);
  const mockExecFileQuiet = jest.mocked(execFileQuiet);
  const mockBuildAugmentedEnv = jest.mocked(buildAugmentedEnvAsync);
  const mockBuildShellCommandArgs = jest.mocked(buildShellCommandArgs);
  const mockBuildTmuxInlineEnvPrefix = jest.mocked(buildTmuxInlineEnvPrefix);
  const mockFindBinary = jest.mocked(findBinary);
  const mockGetDefaultUserShell = jest.mocked(getDefaultUserShell);
  const mockNormalizeShellForPlatform = jest.mocked(normalizeShellForPlatform);
  const mockShouldUseTmux = jest.mocked(shouldUseTmux);

  let tmpDir: string;
  let manager: ActionPtyManager | null;

  beforeEach(() => {
    jest.resetAllMocks();
    manager = null;
    jest
      .spyOn(ActionPtyManager.prototype as any, 'waitForFile')
      .mockResolvedValue(true);
    jest.mocked(execFileAsync).mockImplementation(async (_file, args) => ({
      stdout: args[0] === 'display-message' ? '123\t1' : '',
      stderr: '',
    }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevenex-action-test-'));
    jest
      .spyOn(ActionPtyManager.prototype as any, 'getLogFilePath')
      .mockImplementation((id: unknown) => path.join(tmpDir, `${id}.log`));
    jest
      .spyOn(ActionPtyManager.prototype as any, 'getExitCodePath')
      .mockImplementation((id: unknown) => path.join(tmpDir, `${id}.exitcode`));
    mockBuildAugmentedEnv.mockResolvedValue({
      PATH: '/repo/bin:/usr/bin',
      SHELL: '/custom/zsh',
      PWD: '/backend/root',
      ELEVENEX_ACTION_TOKEN: 'abc 123',
      ELEVENEX_ACTION_QUOTED: "it's ok",
      'ELEVENEX-INVALID-KEY': 'ignored',
    });
    mockBuildTmuxInlineEnvPrefix.mockReturnValue("PATH='/repo/bin'");
    mockBuildShellCommandArgs.mockImplementation((_shell, command) => [
      '-lc',
      command,
    ]);
    mockGetDefaultUserShell.mockReturnValue('/bin/sh');
    mockNormalizeShellForPlatform.mockImplementation((shell) => shell);
    mockShouldUseTmux.mockReturnValue(true);
    mockExecFileQuiet.mockResolvedValue(undefined);
    mockSpawn.mockReturnValue(createMockPty() as never);
  });

  afterEach(() => {
    manager?.onModuleDestroy();
    for (const process of createdPtys.splice(0))
      process.emit('exit', { exitCode: 0 });
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns direct actions with the worktree-specific shell env and cwd', async () => {
    mockFindBinary.mockReturnValue(null);
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    });

    await manager.start({
      id: 10,
      worktreePath: tmpDir,
      command: 'node -v',
    });

    expect(mockBuildAugmentedEnv).toHaveBeenCalledWith(process.env, tmpDir);
    expect(mockSpawn).toHaveBeenCalledWith('/custom/zsh', ['-lc', 'node -v'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: tmpDir,
      env: expect.objectContaining({
        PATH: '/repo/bin:/usr/bin',
        PWD: tmpDir,
        SHELL: '/custom/zsh',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      }),
    });
  });

  it('waits for direct action exit when finishing a task', async () => {
    mockFindBinary.mockReturnValue(null);
    const process = createMockPty();
    process.onExit.mockImplementation((callback) => {
      process.on('exit', callback);
      return { dispose: () => process.off('exit', callback) };
    });
    mockSpawn.mockReturnValue(process as never);
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn(),
      flushCurrentOutput: jest.fn(),
      finalizeRun: jest.fn(),
    });
    await manager.start({ id: 10, worktreePath: tmpDir, command: 'build' });
    let stopped = false;
    const pending = manager.stop(10, true).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    process.emit('exit', { exitCode: 0 });
    await pending;
    expect(manager.isRunning(10)).toBe(false);
  });

  it('retains the environment if an action is still starting and rechecks ownership before spawning', async () => {
    mockFindBinary.mockReturnValue(null);
    const env = createDeferred<NodeJS.ProcessEnv>();
    mockBuildAugmentedEnv.mockReturnValueOnce(env.promise);
    manager = new ActionPtyManager();
    const assertCanRun = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Task finished'));
    manager.registerPersistence({
      assertCanRun,
      markRunning: jest.fn(),
      flushCurrentOutput: jest.fn(),
      finalizeRun: jest.fn(),
    });
    const pending = manager.start({
      id: 10,
      worktreePath: tmpDir,
      command: 'build',
    });
    const rejected = expect(pending).rejects.toThrow('Task finished');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(manager.stop(10, true)).rejects.toThrow('still starting');
    env.resolve({});
    await rejected;
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not resolve or invoke tmux when the backend is local', async () => {
    mockShouldUseTmux.mockReturnValue(false);
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    });

    await manager.start({
      id: 13,
      worktreePath: tmpDir,
      command: 'node -v',
    });

    expect(mockFindBinary).not.toHaveBeenCalled();
    expect(mockExecFileQuiet).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      '/custom/zsh',
      ['-lc', 'node -v'],
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it('reattaches tmux actions with the original worktree env and cwd', async () => {
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    manager = new ActionPtyManager();

    await expect(manager.reattach(42, tmpDir)).resolves.toBe(true);

    expect(mockBuildAugmentedEnv).toHaveBeenCalledWith(process.env, tmpDir);
    expect(mockSpawn).toHaveBeenCalledWith(
      'tail',
      ['-c', '+1', '-F', path.join(tmpDir, '42.log')],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: tmpDir,
        env: expect.objectContaining({
          PATH: '/repo/bin:/usr/bin',
          PWD: tmpDir,
          SHELL: '/custom/zsh',
        }),
      },
    );
  });

  it('starts tmux actions with the full augmented env inlined into the command wrapper', async () => {
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    });

    await manager.start({
      id: 11,
      worktreePath: tmpDir,
      command: 'printenv ELEVENEX_ACTION_TOKEN',
    });

    expect(mockBuildTmuxInlineEnvPrefix).toHaveBeenCalledWith(
      expect.objectContaining({
        PATH: '/repo/bin:/usr/bin',
        PWD: tmpDir,
        ELEVENEX_ACTION_TOKEN: 'abc 123',
        ELEVENEX_ACTION_QUOTED: "it's ok",
        TERM: 'xterm-256color',
      }),
      { mode: 'full' },
    );
    expect(mockBuildTmuxInlineEnvPrefix).toHaveBeenCalledTimes(1);

    const newSessionCall = mockExecFileQuiet.mock.calls.find(([, args]) =>
      args.includes('new-session'),
    );
    expect(newSessionCall?.[1].join(' ')).toContain("PATH='\\''/repo/bin'\\''");
  });

  it('rejects concurrent starts for the same action while async env setup is pending', async () => {
    mockFindBinary.mockReturnValue(null);
    const env = createDeferred<NodeJS.ProcessEnv>();
    const envRequested = createDeferred<void>();
    mockBuildAugmentedEnv.mockImplementation(() => {
      envRequested.resolve();
      return env.promise;
    });
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    });

    const firstStart = manager.start({
      id: 12,
      worktreePath: tmpDir,
      command: 'node -v',
    });
    await envRequested.promise;

    await expect(
      manager.start({
        id: 12,
        worktreePath: tmpDir,
        command: 'node -v',
      }),
    ).rejects.toThrow('Action 12 is already running');

    env.resolve({
      PATH: '/repo/bin:/usr/bin',
      SHELL: '/custom/zsh',
    });
    await firstStart;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
  function setup(tmux = false) {
    mockFindBinary.mockReturnValue(tmux ? '/usr/bin/tmux' : null);
    manager = new ActionPtyManager();
    // Keep all test artifacts scoped to this test, including completion markers.
    jest
      .spyOn(manager as any, 'getLogFilePath')
      .mockReturnValue(path.join(tmpDir, 'action.log'));
    jest
      .spyOn(manager as any, 'getExitCodePath')
      .mockReturnValue(path.join(tmpDir, 'action.exitcode'));
    const persistence = {
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    };
    const gateway = { sendToAction: jest.fn(), notifyStatus: jest.fn() };
    manager.registerPersistence(persistence);
    manager.registerGateway(gateway);
    return {
      persistence,
      gateway,
      action: { id: 91, worktreePath: tmpDir, command: 'side-effect' },
    };
  }

  it('never escalates a stopped run into a newer rerun', async () => {
    jest.useFakeTimers();
    try {
      const { action, persistence } = setup();
      const first = createMockPty();
      const second = createMockPty();
      mockSpawn
        .mockReturnValueOnce(first as never)
        .mockReturnValueOnce(second as never);
      await manager!.start(action);
      await manager!.stop(action.id);
      first.emit('exit', { exitCode: 143 });
      await new Promise<void>((resolve) =>
        jest.requireActual('node:timers').setImmediate(resolve),
      );
      expect(manager!.isRunning(action.id)).toBe(false);
      await manager!.start(action);
      jest.advanceTimersByTime(2000);
      expect(first.kill.mock.calls).toEqual([['SIGTERM']]);
      expect(second.kill).not.toHaveBeenCalled();
      expect(persistence.finalizeRun).toHaveBeenCalledTimes(1);
      expect(manager!.isRunning(action.id)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('escalates only the concrete action and shares concurrent strict stops', async () => {
    jest.useFakeTimers();
    try {
      const { action, persistence } = setup();
      const process = createMockPty();
      mockSpawn.mockReturnValue(process as never);
      await manager!.start(action);
      const stops = Promise.all([
        manager!.stop(action.id, true),
        manager!.stop(action.id, true),
      ]);
      jest.advanceTimersByTime(1500);
      expect(process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
      process.emit('exit', { exitCode: 137 });
      await stops;
      expect(persistence.finalizeRun).toHaveBeenCalledTimes(1);
      expect(persistence.finalizeRun.mock.calls[0][1].status).toBe('stopped');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['new-session', 'set-option', 'tail'])(
    'cleans partial tmux setup without direct fallback after %s fails',
    async (failure) => {
      const { action } = setup(true);
      mockExecFileQuiet.mockImplementation(async (_file, args) => {
        if (args[0] === 'has-session') throw new Error('No session');
        if (args[0] === failure) throw new Error('setup failed');
      });
      if (failure === 'tail')
        mockSpawn.mockImplementation(() => {
          throw new Error('setup failed');
        });
      await expect(manager!.start(action)).rejects.toThrow('setup failed');
      expect(mockSpawn.mock.calls.every(([file]) => file === 'tail')).toBe(
        true,
      );
      expect(
        mockExecFileQuiet.mock.calls.some(
          ([, args]) => args[0] === 'kill-session',
        ),
      ).toBe(true);
      expect(manager!.isRunning(action.id)).toBe(false);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    },
  );

  it('holds the launch gate until logging and tail are ready', async () => {
    const { action } = setup(true);
    const ready = createDeferred<boolean>();
    jest.spyOn(manager as any, 'waitForFile').mockReturnValue(ready.promise);
    mockExecFileQuiet.mockImplementation(async (_file, args) => {
      if (args[0] === 'has-session') throw new Error('No session');
    });
    const start = manager!.start(action);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      mockExecFileQuiet.mock.calls.some(([, args]) =>
        args.includes('pipe-pane'),
      ),
    ).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(tmpDir).some((file) => file.includes('.launch-')),
    ).toBe(false);
    ready.resolve(true);
    await start;
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(
      fs.readdirSync(tmpDir).some((file) => file.includes('.launch-')),
    ).toBe(true);
  });

  it('serializes an in-flight output flush before final persistence', async () => {
    const { action, persistence } = setup();
    const flushed = createDeferred<void>();
    persistence.flushCurrentOutput.mockReturnValue(flushed.promise);
    const process = createMockPty();
    mockSpawn.mockReturnValue(process as never);
    await manager!.start(action);
    process.onData.mock.calls[0][0]('first');
    (manager as any).flushCurrentOutput(
      (manager as any).processes.get(action.id),
    );
    await Promise.resolve();
    process.onData.mock.calls[0][0](' last');
    process.emit('exit', { exitCode: 0 });
    await Promise.resolve();
    expect(persistence.finalizeRun).not.toHaveBeenCalled();
    flushed.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(persistence.finalizeRun.mock.calls[0][1]).toMatchObject({
      status: 'success',
      lastOutput: 'first last',
      currentOutput: '',
    });
    expect(manager!.isRunning(action.id)).toBe(false);
  });

  it('coalesces completion snapshots and ignores an old poll after an action reruns', async () => {
    const { action, persistence } = setup(true);
    const first = createMockPty();
    first.kill.mockImplementation(() => first.emit('exit', { exitCode: 0 }));
    const second = createMockPty();
    mockSpawn
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    await manager!.start(action);
    const check = createDeferred<{ stdout: string; stderr: string }>();
    jest
      .mocked(execFileAsync)
      .mockImplementation((_file, args) =>
        args[0] === 'display-message'
          ? Promise.resolve({ stdout: '123\t1', stderr: '' })
          : check.promise,
      );
    const poll = (manager as any).pollCompletions();
    await (manager as any).pollCompletions();
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    await manager!.stop(action.id);
    await manager!.start(action);
    check.resolve({ stdout: '', stderr: '' });
    await poll;
    expect(second.kill).not.toHaveBeenCalled();
    expect(persistence.finalizeRun).toHaveBeenCalledTimes(1);
    expect(manager!.isRunning(action.id)).toBe(true);
  });

  it('uses one pane snapshot for multiple actions and leaves them running on a poll error', async () => {
    const { action } = setup(true);
    mockSpawn.mockImplementation(() => createMockPty() as never);
    await manager!.start(action);
    await manager!.start({ ...action, id: 92 });
    jest
      .mocked(execFileAsync)
      .mockRejectedValueOnce(new Error('permission denied'));
    await (manager as any).pollCompletions();
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(manager!.isRunning(91)).toBe(true);
    expect(manager!.isRunning(92)).toBe(true);
  });

  it('drains the log before its bounded final snapshot and ignores late tail output', async () => {
    const { action, persistence } = setup(true);
    const process = createMockPty();
    process.kill.mockImplementation(() =>
      process.emit('exit', { exitCode: 0 }),
    );
    mockSpawn.mockReturnValue(process as never);
    await manager!.start(action);
    const drained = createDeferred<void>();
    jest
      .spyOn(manager as any, 'waitForLogDrain')
      .mockReturnValue(drained.promise);
    const stop = manager!.stop(action.id, true);
    await new Promise((resolve) => setImmediate(resolve));
    fs.writeFileSync(path.join(tmpDir, 'action.log.1'), 'old');
    fs.writeFileSync(path.join(tmpDir, 'action.log'), ' final');
    drained.resolve();
    await stop;
    process.onData.mock.calls[0][0]('stale tail');
    expect(persistence.finalizeRun.mock.calls[0][1].lastOutput).toBe(
      'old final',
    );
    expect(persistence.finalizeRun).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
  it('completes a vanished tmux server but does not mistake connection permission errors for exit', async () => {
    const { action, persistence } = setup(true);
    const process = createMockPty();
    process.kill.mockImplementation(() =>
      process.emit('exit', { exitCode: 0 }),
    );
    mockSpawn.mockReturnValue(process as never);
    await manager!.start(action);
    jest.mocked(execFileAsync).mockRejectedValueOnce(
      Object.assign(new Error('missing'), {
        stderr: 'no server running on /tmp/test',
      }),
    );
    const current = (manager as any).processes.get(action.id);
    await (manager as any).pollCompletions();
    await current.completion;
    expect(persistence.finalizeRun).toHaveBeenCalledTimes(1);
    expect(manager!.isRunning(action.id)).toBe(false);
  });

  it('preserves the observed exit code when persistence fails and strict stop retries', async () => {
    const { action, persistence } = setup();
    const process = createMockPty();
    mockSpawn.mockReturnValue(process as never);
    persistence.finalizeRun.mockRejectedValueOnce(new Error('database busy'));
    await manager!.start(action);
    process.emit('exit', { exitCode: 7 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager!.isRunning(action.id)).toBe(true);
    process.kill.mockImplementation(() =>
      process.emit('exit', { exitCode: 0 }),
    );
    await manager!.stop(action.id, true);
    expect(persistence.finalizeRun.mock.calls[1][1]).toMatchObject({
      status: 'stopped',
      lastExitCode: 7,
    });
  });
  it('escalates the captured tmux process group while retaining the pane for output drain', async () => {
    jest.useFakeTimers();
    const signal = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const { action } = setup(true);
      const started = Date.now();
      jest.mocked(execFileAsync).mockImplementation(async (_file, args) => ({
        stdout:
          args[0] === 'display-message'
            ? `23456\t${Date.now() - started >= 1600 ? 1 : 0}`
            : 'elevenex-action-91\t0',
        stderr: '',
      }));
      await manager!.start(action);
      mockExecFileQuiet.mockClear();
      const pane = (manager as any).processes.get(action.id);
      const pending = (manager as any).terminateTmuxPane(pane);
      await jest.advanceTimersByTimeAsync(1600);
      await pending;
      expect(signal.mock.calls).toEqual([
        [process.platform === 'win32' ? 23456 : -23456, 'SIGTERM'],
        [process.platform === 'win32' ? 23456 : -23456, 'SIGKILL'],
      ]);
      expect(manager!.isRunning(action.id)).toBe(true);
      expect(
        mockExecFileQuiet.mock.calls.some(
          ([, args]) => args[0] === 'kill-session',
        ),
      ).toBe(false);
    } finally {
      signal.mockRestore();
      jest.useRealTimers();
    }
  });

  it('refuses to escalate when the pane process changes during stop', async () => {
    jest.useFakeTimers();
    const signal = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const { action } = setup(true);
      await manager!.start(action);
      jest
        .mocked(execFileAsync)
        .mockResolvedValueOnce({ stdout: '23456\t0', stderr: '' })
        .mockResolvedValueOnce({ stdout: '23457\t0', stderr: '' });
      const pane = (manager as any).processes.get(action.id);
      const rejected = expect(
        (manager as any).terminateTmuxPane(pane),
      ).rejects.toThrow('pane changed');
      await jest.advanceTimersByTimeAsync(50);
      await rejected;
      expect(signal.mock.calls).toEqual([
        [process.platform === 'win32' ? 23456 : -23456, 'SIGTERM'],
      ]);
      expect(manager!.isRunning(action.id)).toBe(true);
    } finally {
      signal.mockRestore();
      jest.useRealTimers();
    }
  });
  it('keeps a surviving tmux pipe intact on reattach instead of toggling it off', async () => {
    setup(true);
    jest
      .mocked(execFileAsync)
      .mockResolvedValue({ stdout: '1\t0', stderr: '' });
    expect(await manager!.reattach(91, tmpDir)).toBe(true);
    expect(
      mockExecFileQuiet.mock.calls.some(([, args]) => args[0] === 'pipe-pane'),
    ).toBe(false);
  });
  function serviceFor(action: {
    id: number;
    worktreePath: string;
    command: string;
  }) {
    const where = jest.fn().mockResolvedValue(undefined);
    const db = { delete: jest.fn(() => ({ where })) };
    const service = new ActionsService(db as never, manager!);
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({
        ...action,
        name: 'Test',
        status: 'idle',
        workspaceId: null,
      } as never);
    jest.spyOn(service, 'markRunning').mockResolvedValue(undefined);
    jest.spyOn(service, 'flushCurrentOutput').mockResolvedValue(undefined);
    jest.spyOn(service, 'finalizeRun').mockResolvedValue(undefined);
    return { service, db };
  }

  it('rejects delete/update while tmux existence is pending, before startup resumes', async () => {
    const { action } = setup(true);
    const { service, db } = serviceFor(action);
    const exists = createDeferred<void>();
    const requested = createDeferred<void>();
    mockExecFileQuiet.mockImplementation((_file, args) => {
      if (args[0] === 'has-session') {
        requested.resolve();
        return exists.promise;
      }
      return Promise.resolve();
    });
    const pending = manager!.start(action);
    await requested.promise;
    expect(manager!.isRunning(action.id)).toBe(true);
    await expect(service.remove(action.id)).rejects.toThrow(
      'Cannot delete a running action',
    );
    await expect(
      service.update(action.id, { command: 'changed' }),
    ).rejects.toThrow('Cannot edit a running action');
    expect(db.delete).not.toHaveBeenCalled();
    exists.reject(new Error('No session'));
    await pending;
    expect(manager!.isRunning(action.id)).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('keeps delete ownership across tmux cleanup so startup cannot enter behind it', async () => {
    const { action } = setup(true);
    const { service, db } = serviceFor(action);
    const killed = createDeferred<void>();
    const requested = createDeferred<void>();
    mockExecFileQuiet.mockImplementation((_file, args) => {
      if (args[0] === 'kill-session') {
        requested.resolve();
        return killed.promise;
      }
      return Promise.resolve();
    });
    const pending = service.remove(action.id);
    await requested.promise;
    await expect(manager!.start(action)).rejects.toThrow('already running');
    expect(mockSpawn).not.toHaveBeenCalled();
    killed.resolve();
    await pending;
    expect(db.delete).toHaveBeenCalledTimes(1);
    const release = manager!.reserveIdleAction(action.id);
    expect(release).not.toBeNull();
    release!();
  });

  it('resumes reattached output from the captured snapshot end', async () => {
    setup(true);
    const log = path.join(tmpDir, 'action.log');
    fs.writeFileSync(log, 'before');
    mockSpawn.mockImplementation((_file, args) => {
      fs.appendFileSync(log, ' during attach');
      expect(args).toEqual(['-c', '+7', '-F', log]);
      return createMockPty() as never;
    });
    expect(await manager!.reattach(91, tmpDir)).toBe(true);
    expect(manager!.getCurrentOutput(91)).toBe('before');
  });
});
