import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { execFileAsync, execFileQuiet } from './async-process.js';
import { PtyManager } from './pty-manager.service.js';
import { UserPtyManager } from '../user-terminal/user-pty-manager.service.js';
import { ActionPtyManager } from '../actions/action-pty-manager.service.js';
import * as systemPaths from '../config/system-paths.js';
import { terminatePtyAndWait } from './pty-termination.js';

// Native integration is opt-in so CI without node-pty/tmux can run mocked suites.
const nativeDescribe =
  process.env.ELEVENEX_PROCESS_TESTS === '1' && process.platform !== 'win32'
    ? describe
    : describe.skip;

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeout = 45000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for process lifecycle');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

nativeDescribe('native PTY lifecycle', () => {
  jest.setTimeout(60000);
  let dir: string;
  const children: pty.IPty[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elevenex-pty-native-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const child of children.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function resistantProcess(): Promise<pty.IPty> {
    const child = pty.spawn(
      '/bin/sh',
      ['-c', "trap '' HUP TERM; printf READY; while :; do sleep 0.1; done"],
      { cwd: dir, env: { PATH: '/usr/bin:/bin' } },
    );
    children.push(child);
    let ready = false;
    child.onData((data) => {
      ready ||= data.includes('READY');
    });
    await until(() => ready);
    return child;
  }

  it.each(['agent', 'user'])(
    'kills a real HUP/TERM-resistant %s PTY after normal stop',
    async (kind) => {
      const child = await resistantProcess();
      let exited = false;
      child.onExit(() => {
        exited = true;
      });
      jest.spyOn(pty, 'spawn').mockReturnValue(child);
      jest
        .spyOn(systemPaths, 'buildAugmentedEnvAsync')
        .mockResolvedValue({ PATH: '/usr/bin:/bin' });
      jest.spyOn(systemPaths, 'findBinary').mockReturnValue(null);
      const manager =
        kind === 'agent'
          ? new PtyManager(
              { sendToSession() {}, onUnexpectedExit() {} } as never,
              { isTmuxAvailable: () => false, killSession() {} } as never,
              { registerLaunch() {}, markLaunchInactive() {} } as never,
            )
          : new UserPtyManager({
              sendToTerminal() {},
              onProcessExit() {},
            } as never);
      if (manager instanceof PtyManager) {
        jest
          .spyOn(manager as any, 'buildHooksSettingsArgs')
          .mockResolvedValue([]);
        await manager.spawn(1, dir);
      } else await manager.spawn(1, dir, '/bin/sh');
      expect(manager.kill(1)).toBe(true);
      expect(manager.isAlive(1)).toBe(false);
      await until(() => exited);
      expect(() => process.kill(child.pid, 0)).toThrow();
      if (manager instanceof PtyManager) await manager.stopForTask(1);
      else await manager.destroy(1, true);
      manager.onModuleDestroy();
    },
    60000,
  );

  it('awaits and coalesces real TERM-resistant process exit', async () => {
    const child = await resistantProcess();
    const first = terminatePtyAndWait(child);
    expect(terminatePtyAndWait(child)).toBe(first);
    await first;
    expect(() => process.kill(child.pid, 0)).toThrow();
  });
});

nativeDescribe('native tmux actions', () => {
  jest.setTimeout(60000);
  let dir: string;
  let socket: string;
  let tmux: string;
  let manager: ActionPtyManager;
  let finalized: jest.Mock;
  let actionId: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elevenex-action-native-'));
    socket = path.join(dir, 'tmux.sock');
    const binary = systemPaths.findBinary('tmux');
    if (!binary) throw new Error('ELEVENEX_PROCESS_TESTS requires tmux');
    // An isolated server prevents tests touching a user's sessions or config.
    tmux = path.join(dir, 'tmux');
    await fs.writeFile(
      tmux,
      `#!/bin/sh\nexec '${binary.replace(/'/g, "'\\''")}' -S '${socket.replace(/'/g, "'\\''")}' -f /dev/null "$@"\n`,
      { mode: 0o700 },
    );
    jest
      .spyOn(systemPaths, 'findBinary')
      .mockImplementation((name) => (name === 'tmux' ? tmux : null));
    jest
      .spyOn(systemPaths, 'buildAugmentedEnvAsync')
      .mockResolvedValue({ PATH: '/usr/bin:/bin', SHELL: '/bin/sh' });
    manager = new ActionPtyManager();
    // The runtime defaults to local outside the app; enable tmux for this test.
    (manager as any).tmuxEnabled = true;
    (manager as any).tmuxBin = tmux;
    jest
      .spyOn(manager as any, 'getLogFilePath')
      .mockReturnValue(path.join(dir, 'action.log'));
    jest
      .spyOn(manager as any, 'getExitCodePath')
      .mockReturnValue(path.join(dir, 'action.exitcode'));
    actionId = 1000 + Math.floor(Math.random() * 1000000);
    finalized = jest.fn().mockResolvedValue(undefined);
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: finalized,
    });
  });
  afterEach(async () => {
    if (manager?.isRunning(actionId))
      await manager.stop(actionId, true).catch(() => undefined);
    manager?.onModuleDestroy();
    await execFileQuiet(tmux, ['kill-server']).catch(() => undefined);
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('executes an instant side effect once and captures its output and exit status', async () => {
    await manager.start({
      id: actionId,
      worktreePath: dir,
      command: 'printf x >> count; printf "first\\nlast\\n"; exit 7',
    });
    await until(() => !manager.isRunning(actionId));
    expect(await fs.readFile(path.join(dir, 'count'), 'utf8')).toBe('x');
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(finalized.mock.calls[0][1]).toMatchObject({
      status: 'failed',
      lastExitCode: 7,
      lastOutput: 'first\r\nlast\r\n',
    });
    expect(await manager.hasTmuxSessionForAction(actionId)).toBe(false);
  }, 60000);

  it('does not run the command if pipe setup fails and leaves no orphan session', async () => {
    const original = await fs.readFile(tmux, 'utf8');
    await fs.writeFile(
      tmux,
      original.replace(
        'exec ',
        'case "$*" in *pipe-pane*) exit 1;; esac\nexec ',
      ),
      { mode: 0o700 },
    );
    await expect(
      manager.start({
        id: actionId,
        worktreePath: dir,
        command: 'printf x >> count',
      }),
    ).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'count'))).rejects.toThrow();
    expect(await manager.hasTmuxSessionForAction(actionId)).toBe(false);
    expect(
      (await fs.readdir(dir)).some(
        (file) => file.includes('.launch-') || file.startsWith('action.log'),
      ),
    ).toBe(false);
  }, 60000);

  it('caps a chatty action log, reattaches after restart, and persists the final suffix', async () => {
    const command = `${process.execPath} -e 'process.stdout.write(("a".repeat(79)+"\\n").repeat(40000)); setTimeout(()=>process.stdout.write("FINAL\\n"),1200); setTimeout(()=>{},100000)'`;
    await manager.start({ id: actionId, worktreePath: dir, command });
    try {
      await until(
        async () =>
          (await fs.stat(path.join(dir, 'action.log.1')).catch(() => null)) !==
          null,
      );
    } catch (error) {
      const files = await fs.readdir(dir);
      const log = await fs
        .readFile(path.join(dir, 'action.log'), 'utf8')
        .catch(() => 'missing');
      const pane = await execFileAsync(tmux, [
        'capture-pane',
        '-p',
        '-t',
        `elevenex-action-${actionId}`,
      ]).catch((error) => ({ stdout: String(error) }));
      throw new Error(
        `${error}; files=${files}; log=${log.slice(-1000)}; pane=${pane.stdout}; final=${JSON.stringify(finalized.mock.calls)}`,
      );
    }
    expect(
      (await fs.stat(path.join(dir, 'action.log'))).size,
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(
      (await fs.stat(path.join(dir, 'action.log.1'))).size,
    ).toBeLessThanOrEqual(1024 * 1024);
    manager.onModuleDestroy();
    const replacement = new ActionPtyManager();
    (replacement as any).tmuxEnabled = true;
    (replacement as any).tmuxBin = tmux;
    jest
      .spyOn(replacement as any, 'getLogFilePath')
      .mockReturnValue(path.join(dir, 'action.log'));
    jest
      .spyOn(replacement as any, 'getExitCodePath')
      .mockReturnValue(path.join(dir, 'action.exitcode'));
    replacement.registerPersistence({
      markRunning: jest.fn(),
      flushCurrentOutput: jest.fn(),
      finalizeRun: finalized,
    });
    manager = replacement;
    expect(await manager.reattach(actionId, dir)).toBe(true);
    await until(async () => {
      const { stdout } = await execFileAsync(tmux, [
        'capture-pane',
        '-p',
        '-t',
        `elevenex-action-${actionId}`,
      ]);
      return stdout.includes('FINAL');
    });
    await manager.stop(actionId, true);
    expect(finalized).toHaveBeenCalledTimes(1);
    const output = finalized.mock.calls[0][1].lastOutput as string;
    expect(output.length).toBe(50_000);
    expect(output.slice(-80)).toMatch(/FINAL\r\n$/);
    expect(finalized.mock.calls[0][1].status).toBe('stopped');
    expect(
      (await fs.readdir(dir)).filter((file) => file.startsWith('action.log')),
    ).toEqual([]);
  }, 60000);
});
