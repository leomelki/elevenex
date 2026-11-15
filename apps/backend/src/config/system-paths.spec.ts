import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

type MockShellProcess = EventEmitter & {
  stdout: EventEmitter & { destroy: jest.Mock };
  pid: number;
  kill: jest.Mock;
};

let systemPaths: typeof import('./system-paths.js');
let mockExecSync: jest.Mock;
let mockSpawn: jest.Mock;
let killProcessSpy: jest.SpyInstance;
let originalEnv: NodeJS.ProcessEnv;
let children: MockShellProcess[];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

jest.mock('@nestjs/common', () => ({
  Logger: jest.fn(() => ({ log: jest.fn(), warn: jest.fn() })),
}));

function loadSystemPaths(): void {
  jest.resetModules();
  const childProcess = require('child_process');
  mockExecSync = childProcess.execSync;
  mockSpawn = childProcess.spawn;
  systemPaths = require('./system-paths.js');
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ now: 0 });
  originalEnv = process.env;
  process.env = {
    ...originalEnv,
    ELEVENEX_SHELL_CACHE_ENTRIES: '64',
    ELEVENEX_SHELL_QUEUE_TIMEOUT_MS: '30000',
  };
  for (const key of [
    'ZDOTDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
  ])
    delete process.env[key];
  process.env.SHELL = originalEnv.SHELL || '/bin/sh';
  children = [];
  killProcessSpy = jest.spyOn(process, 'kill').mockReturnValue(true);
  loadSystemPaths();
});

afterEach(async () => {
  // Also drain pending work on assertion failure, without real shell startups
  // or leaving deadline timers/listeners to leak into the next test.
  await jest.runAllTimersAsync();
  expect(jest.getTimerCount()).toBe(0);
  for (const child of children) {
    expect(child.eventNames()).toEqual([]);
    expect(child.stdout.eventNames()).toEqual([]);
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
  Object.defineProperty(process, 'platform', originalPlatform);
  process.env = originalEnv;
});
const envBoundary = '>>>ELEVENEX_ENV_BOUNDARY<<<';
const envEndBoundary = '>>>ELEVENEX_ENV_END<<<';
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function envOutput(binPath: string, entries = ''): string {
  return `${envBoundary}PATH=${binPath}\0ELEVENEX_TEST_ENV=1\0${entries}${envEndBoundary}`;
}

function createShellProcess(): MockShellProcess {
  const child = new EventEmitter() as MockShellProcess;
  child.stdout = Object.assign(new EventEmitter(), { destroy: jest.fn() });
  child.pid = 10_000 + children.length;
  children.push(child);
  child.kill = jest.fn();
  return child;
}

async function closeShellProcess(
  child: MockShellProcess,
  output: string,
): Promise<void> {
  child.stdout.emit('data', Buffer.from(output));
  child.emit('close', 0);
  await jest.advanceTimersByTimeAsync(0);
}

describe('findBinary PATH precedence', () => {
  let executables: Set<string>;
  let access: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'linux',
    });
    loadSystemPaths();
    executables = new Set();
    // Model installations without touching the host's /usr/local/bin or CLIs.
    access = jest
      .spyOn(jest.requireActual<typeof fs>('fs'), 'accessSync')
      .mockImplementation((candidate) => {
        if (!executables.has(String(candidate))) throw new Error('unavailable');
      });
  });

  it.each(['codex', 'claude', 'pi', 'opencode', 'tmux', 'pwsh', 'powershell'])(
    'prefers %s on PATH over /usr/local/bin',
    (name) => {
      const userBin = path.join(os.homedir(), '.local', 'bin');
      const userExecutable = path.join(userBin, name);
      executables.add(userExecutable);
      executables.add(path.join('/usr/local/bin', name));
      process.env.PATH = `${userBin}:/usr/local/bin`;

      expect(systemPaths.findBinary(name)).toBe(userExecutable);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/tools/first:/tools/second', '/tools/first'],
    ['/tools/second:/tools/first', '/tools/second'],
  ])('respects PATH directory order: %s', (pathValue, preferred) => {
    process.env.PATH = pathValue;
    executables.add(path.join('/tools/first', 'codex'));
    executables.add(path.join('/tools/second', 'codex'));

    expect(systemPaths.findBinary('codex')).toBe(path.join(preferred, 'codex'));
    expect(access).toHaveBeenCalledWith(
      path.join(preferred, 'codex'),
      fs.constants.X_OK,
    );
  });

  it.each(['', '/usr/bin:/bin:/usr/sbin:/sbin'])(
    'uses a known install directory when PATH has no match: %s',
    (pathValue) => {
      process.env.PATH = pathValue;
      const fallback = path.join(os.homedir(), '.local', 'bin', 'codex');
      executables.add(fallback);

      expect(systemPaths.findBinary('codex')).toBe(fallback);
    },
  );

  it('returns null for a missing executable and retries misses without cache clearing', () => {
    process.env.PATH = '/tools/bin';
    expect(systemPaths.findBinary('codex')).toBeNull();
    const installed = path.join('/tools/bin', 'codex');
    executables.add(installed);

    expect(systemPaths.findBinary('codex')).toBe(installed);
  });

  it('follows PATH changes and revalidates cached executable paths', () => {
    const first = path.join('/tools/first', 'codex');
    const second = path.join('/tools/second', 'codex');
    executables.add(first);
    executables.add(second);
    process.env.PATH = '/tools/first:/tools/second';
    expect(systemPaths.findBinary('codex')).toBe(first);

    process.env.PATH = '/tools/second:/tools/first';
    access.mockClear();
    expect(systemPaths.findBinary('codex')).toBe(second);
    expect(access).toHaveBeenCalled();

    executables.delete(second);
    expect(systemPaths.findBinary('codex')).toBe(first);

    systemPaths.clearBinaryPathCache();
    expect(systemPaths.findBinary('codex')).toBe(first);
  });

  it('resolves an absolute executable path without prepending PATH directories', () => {
    executables.add('/custom/codex');
    expect(systemPaths.findBinary('/custom/codex')).toBe('/custom/codex');
    executables.delete('/custom/codex');
    expect(systemPaths.findBinary('/custom/codex')).toBeNull();
  });

  it('preserves relative configured executable paths', () => {
    executables.add('./tools/custom-codex');
    expect(systemPaths.findBinary('./tools/custom-codex')).toBe(
      './tools/custom-codex',
    );
  });

  it('follows the projected login-shell PATH before known fallback directories', async () => {
    process.env.PATH = '/usr/bin:/bin';
    mockSpawn.mockImplementation(() => createShellProcess());
    const refresh = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(children[0], envOutput('/shell/bin'));
    await refresh;
    executables.add(path.join('/shell/bin', 'codex'));
    executables.add(path.join('/usr/local/bin', 'codex'));

    expect(systemPaths.findBinary('codex')).toBe(
      path.join('/shell/bin', 'codex'),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describePosix('system-paths per-cwd env cache', () => {
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('returns fallback env immediately on per-cwd cold miss while async refresh runs', async () => {
    const cwd = '/repo/cold-miss-nonblocking';
    const baseEnv = { PATH: '/base/bin' };
    const refreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(refreshProcess as never);

    const coldResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(coldResult.PATH).toMatch(/^\/base\/bin:/);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await closeShellProcess(refreshProcess, envOutput('/fresh/bin'));

    const refreshedResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(refreshedResult.PATH).toMatch(/^\/fresh\/bin:/);
  });

  it('returns stale per-cwd cache immediately while a single async refresh runs', async () => {
    const cwd = '/repo/stale-returns-immediately';
    const baseEnv = { PATH: '/base/bin' };
    const coldRefreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(coldRefreshProcess as never);

    systemPaths.buildAugmentedEnv(baseEnv, cwd);
    await closeShellProcess(coldRefreshProcess, envOutput('/cached/bin'));

    const refreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(refreshProcess as never);
    nowSpy.mockReturnValue(60_001);

    const staleResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(staleResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(60_100);

    const repeatedStaleResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(repeatedStaleResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(60_200);
    await closeShellProcess(refreshProcess, envOutput('/fresh/bin'));

    const refreshedResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(refreshedResult.PATH).toMatch(/^\/fresh\/bin:/);
  });

  it('throttles completed failed async refresh attempts for one minute', async () => {
    const cwd = '/repo/failed-refresh-throttle';
    const baseEnv = { PATH: '/base/bin' };
    const coldRefreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(coldRefreshProcess as never);

    systemPaths.buildAugmentedEnv(baseEnv, cwd);
    await closeShellProcess(coldRefreshProcess, envOutput('/cached/bin'));

    const failedRefreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(failedRefreshProcess as never);
    nowSpy.mockReturnValue(60_001);

    const staleResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(staleResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(60_002);
    await closeShellProcess(failedRefreshProcess, 'not an env line\n');

    const throttledResult = systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(throttledResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    const nextRefreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(nextRefreshProcess as never);
    nowSpy.mockReturnValue(120_003);

    systemPaths.buildAugmentedEnv(baseEnv, cwd);

    expect(mockSpawn).toHaveBeenCalledTimes(3);

    await closeShellProcess(nextRefreshProcess, envOutput('/fresh/bin'));
  });

  it('does not cache failed binary lookups before PATH changes', () => {
    const originalPath = process.env.PATH;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevenex-bin-'));
    const binaryName = `elevenex-test-bin-${Date.now()}`;
    const binaryPath = path.join(tmpDir, binaryName);

    try {
      process.env.PATH = originalPath ?? '';
      expect(systemPaths.findBinary(binaryName)).toBeNull();

      fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(binaryPath, 0o755);
      process.env.PATH = `${tmpDir}:${originalPath ?? ''}`;

      expect(systemPaths.findBinary(binaryName)).toBe(binaryPath);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describePosix('global shell environment replacement', () => {
  it('lets worktree exports and unsets replace projected globals while retaining explicit overrides', async () => {
    process.env.ELEVENEX_TEST_OVERRIDE = 'launch';
    mockSpawn.mockImplementation(() => createShellProcess());
    const refresh = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[0],
      envOutput(
        '/global/bin',
        `PROJECT_VALUE=global\0REMOVED_IN_PROJECT=global\0`,
      ),
    );
    await refresh;
    const env = systemPaths.buildAugmentedEnvAsync(
      process.env,
      '/repo/context',
    );
    await closeShellProcess(
      children[1],
      envOutput(
        '/project/bin',
        `PROJECT_VALUE=project\0ELEVENEX_TEST_OVERRIDE=project\0`,
      ),
    );
    expect(await env).toMatchObject({
      PROJECT_VALUE: 'project',
      ELEVENEX_TEST_OVERRIDE: 'launch',
    });
    expect((await env).REMOVED_IN_PROJECT).toBeUndefined();
    expect(process.env.PROJECT_VALUE).toBe('global');
    expect(
      systemPaths.buildAugmentedEnv(
        { ...process.env, PROJECT_VALUE: 'caller' },
        '/repo/context',
      ).PROJECT_VALUE,
    ).toBe('caller');
  });

  it('repairs an inherited PATH with thousands of FNM multishells before projecting or launching children', async () => {
    const bins = Array.from(
      { length: 6500 },
      (_, index) => `/tmp/fnm_multishells/${index}_${'x'.repeat(40)}/bin`,
    );
    process.env.PATH = [
      '/usr/bin',
      bins[0],
      '/custom/tools',
      ...bins.slice(1),
      '/bin',
    ].join(':');
    mockSpawn.mockImplementation(() => createShellProcess());
    const refresh = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(children[0], envOutput('/shell/bin'));
    await refresh;
    const paths = process.env.PATH.split(':');
    expect(paths.filter((part) => part.includes('fnm_multishells'))).toEqual([
      bins[0],
    ]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/usr/bin',
        '/custom/tools',
        '/bin',
        '/shell/bin',
      ]),
    );
    expect(Buffer.byteLength(process.env.PATH)).toBeLessThan(2000);
    expect(systemPaths.buildAugmentedEnv().PATH).toBe(process.env.PATH);
  });

  it("prefers a worktree shell's FNM bin over the global shell without accumulating either", async () => {
    process.env.PATH = '/usr/bin:/tmp/fnm_multishells/launch/bin:/custom/bin';
    mockSpawn.mockImplementation(() => createShellProcess());
    const refresh = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[0],
      envOutput('/tmp/fnm_multishells/global/bin:/usr/bin'),
    );
    await refresh;
    const result = systemPaths.buildAugmentedEnvAsync(process.env, '/repo/fnm');
    await closeShellProcess(
      children[1],
      envOutput('/tmp/fnm_multishells/worktree/bin:/usr/bin'),
    );
    const env = await result;
    expect(
      env.PATH?.split(':').filter((part) => part.includes('fnm_multishells')),
    ).toEqual(['/tmp/fnm_multishells/worktree/bin']);
    expect(process.env.PATH).toContain('/tmp/fnm_multishells/launch/bin');
  });

  it('replaces obsolete shell exports and paths while preserving launch and application overrides', async () => {
    process.env.PATH = '/launch/bin';
    process.env.GIT_OPTIONAL_LOCKS = '0';
    process.env.ELEVENEX_TEST_OVERRIDE = 'launch';
    mockSpawn.mockImplementation(() => createShellProcess());
    const first = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[0],
      envOutput(
        '/shell/old/bin',
        `OLD_EXPORT=old\0CHANGED_EXPORT=old\0APPLICATION_EXPORT=shell\0GIT_OPTIONAL_LOCKS=1\0ELEVENEX_TEST_OVERRIDE=shell\0`,
      ),
    );
    await first;
    process.env.APPLICATION_EXPORT = 'application';
    const next = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[1],
      envOutput(
        '/shell/new/bin',
        `CHANGED_EXPORT=new\0APPLICATION_EXPORT=new-shell-value\0`,
      ),
    );
    await next;
    expect(process.env.PATH).toContain('/launch/bin');
    expect(process.env.PATH).toContain('/shell/new/bin');
    expect(process.env.PATH).not.toContain('/shell/old/bin');
    expect(process.env.OLD_EXPORT).toBeUndefined();
    expect(process.env.CHANGED_EXPORT).toBe('new');
    expect(process.env.APPLICATION_EXPORT).toBe('application');
    expect(process.env.ELEVENEX_TEST_OVERRIDE).toBe('launch');
    expect(process.env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('keeps hundreds of changing captures bounded and can still launch Git and a Node subprocess', async () => {
    process.env.PATH = '/usr/bin:/bin';
    mockSpawn.mockImplementation(() => createShellProcess());
    const initialBytes = Buffer.byteLength(JSON.stringify(process.env));
    for (let index = 0; index < 400; index++) {
      const refresh = systemPaths.refreshLoginShellEnv(true);
      await closeShellProcess(
        children[index],
        envOutput(
          `/tools/${index}/${'x'.repeat(512)}`,
          `ROTATING_EXPORT_${index}=${'y'.repeat(512)}\0`,
        ),
      );
      await refresh;
    }
    expect(
      Object.keys(process.env).filter((key) =>
        key.startsWith('ROTATING_EXPORT_'),
      ),
    ).toEqual(['ROTATING_EXPORT_399']);
    expect(
      Buffer.byteLength(JSON.stringify(process.env)) - initialBytes,
    ).toBeLessThan(3000);
    const { execFile } =
      jest.requireActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const launch = (file: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          file,
          args,
          { env: process.env, timeout: 5000, maxBuffer: 4096 },
          (error, stdout) => {
            if (error) reject(new Error(error.message));
            else resolve(stdout);
          },
        );
      });
    await expect(launch('git', ['--version'])).resolves.toMatch(
      /^git version /,
    );
    await expect(
      launch(process.execPath, ['-e', 'process.stdout.write("ok")']),
    ).resolves.toBe('ok');
  });

  it('retains the last good global cache after rejecting an oversized capture', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    const first = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(children[0], envOutput('/shell/good/bin'));
    await first;
    const previous = { ...process.env };
    const next = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[1],
      envOutput('/shell/bad/bin', `API_TOKEN=${'secret-value'.repeat(7000)}\0`),
    );
    await next;
    expect(process.env).toEqual(previous);
    expect(systemPaths.buildAugmentedEnv({}).PATH).toContain('/shell/good/bin');
  });

  it('rejects an oversized combined projection before mutating the backend environment or cache', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    const first = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(children[0], envOutput('/shell/good/bin'));
    await first;
    process.env.CALLER_A = 'a'.repeat(40000);
    process.env.CALLER_B = 'b'.repeat(40000);
    const previous = { ...process.env };
    const next = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[1],
      envOutput(
        '/shell/bad/bin',
        `SHELL_A=${'c'.repeat(40000)}\0SHELL_B=${'d'.repeat(40000)}\0`,
      ),
    );
    await next;
    expect(process.env).toEqual(previous);
    expect(systemPaths.buildAugmentedEnv({}).PATH).toContain('/shell/good/bin');
  });

  it('rejects oversized caller overrides for Git and agents without truncating them', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    const refresh = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(children[0], envOutput('/shell/bin'));
    await refresh;
    const base = { API_TOKEN: 'secret'.repeat(12000) };
    expect(() => systemPaths.buildAugmentedEnv(base)).toThrow(/API_TOKEN:\d+/);
    await expect(systemPaths.buildAugmentedEnvAsync(base)).rejects.toThrow(
      /launch budget/,
    );
    expect(base.API_TOKEN.length).toBe(72000);
  });
});

describePosix('system-paths bounded shell refreshes', () => {
  async function seedGlobalEnv(): Promise<void> {
    mockSpawn.mockImplementation(() => createShellProcess());
    const refresh = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[children.length - 1],
      envOutput('/global/bin'),
    );
    await refresh;
  }

  async function drainCaptures(from = 0): Promise<void> {
    // New queued captures start as these deferred captures settle.
    for (let index = from; index < children.length; index++) {
      expect(
        children.filter((child) => child.stdout.listenerCount('data') > 0),
      ).toHaveLength(Math.min(2, children.length - index));
      const cwd = mockSpawn.mock.calls[index][2].cwd as string | undefined;
      await closeShellProcess(
        children[index],
        envOutput(`${cwd ?? '/global'}/bin`),
      );
    }
  }

  it('serves 1000 warm async reads immediately during a slow background refresh', async () => {
    await seedGlobalEnv();
    const cold = systemPaths.buildAugmentedEnvAsync({}, '/repo/warm');
    await closeShellProcess(children[1], envOutput('/cached/bin'));
    await cold;
    await jest.advanceTimersByTimeAsync(61000);
    const results = await Promise.all(
      Array.from({ length: 1000 }, () =>
        systemPaths.buildAugmentedEnvAsync({}, '/repo/warm'),
      ),
    );
    expect(results.every((env) => env.PATH?.startsWith('/cached/bin:'))).toBe(
      true,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(children[2].stdout.listenerCount('data')).toBe(1);
    await closeShellProcess(children[2], envOutput('/updated/bin'));
    expect(
      (await systemPaths.buildAugmentedEnvAsync({}, '/repo/warm')).PATH,
    ).toMatch(/^\/updated\/bin:/);
  });

  it('refreshes cached environments after the host wall clock moves backwards', async () => {
    jest.setSystemTime(100000);
    await seedGlobalEnv();
    const read = systemPaths.buildAugmentedEnvAsync({}, '/repo/clock');
    await closeShellProcess(children[1], envOutput('/clock/bin'));
    await read;
    jest.setSystemTime(0);
    expect(
      (await systemPaths.buildAugmentedEnvAsync({}, '/repo/clock')).PATH,
    ).toMatch(/^\/clock\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    await closeShellProcess(children[2], envOutput('/clock-updated/bin'));
    const global = systemPaths.refreshLoginShellEnv();
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    await closeShellProcess(children[3], envOutput('/global-updated/bin'));
    await global;
  });

  it('allows a shell taking eight seconds to finish without blocking unrelated work', async () => {
    await seedGlobalEnv();
    const cold = systemPaths.buildAugmentedEnvAsync({}, '/repo/slow');
    await jest.advanceTimersByTimeAsync(8000);
    expect(children[1].stdout.listenerCount('data')).toBe(1);
    expect((await systemPaths.buildAugmentedEnvAsync({})).PATH).toContain(
      '/global/bin',
    );
    await closeShellProcess(children[1], envOutput('/slow/bin'));
    expect((await cold).PATH).toMatch(/^\/slow\/bin:/);
  });

  it('does not hold backend readiness on a long configured capture and bounds cold callers independently', async () => {
    process.env.ELEVENEX_SHELL_CAPTURE_TIMEOUT_MS = '60000';
    loadSystemPaths();
    mockSpawn.mockImplementation(() => createShellProcess());
    const warming = systemPaths.warmShellEnvironment();
    const cold = systemPaths.buildAugmentedEnvAsync({}, '/repo/deferred');
    const rejected = expect(cold).rejects.toThrow('still preparing');
    await jest.advanceTimersByTimeAsync(8000);
    await expect(warming).resolves.toBe(false);
    expect(children[0].stdout.listenerCount('data')).toBe(1);
    await jest.advanceTimersByTimeAsync(12000);
    await rejected;
    await closeShellProcess(children[0], envOutput('/global/bin'));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect((await systemPaths.buildAugmentedEnvAsync({})).PATH).toContain(
      '/global/bin',
    );
  });

  it('cancels a cold waiter without cancelling a capture shared by another caller', async () => {
    await seedGlobalEnv();
    const controller = new AbortController();
    const cancelled = systemPaths.buildAugmentedEnvAsync({}, '/repo/shared', {
      signal: controller.signal,
    });
    const kept = systemPaths.buildAugmentedEnvAsync({}, '/repo/shared');
    const rejection = expect(cancelled).rejects.toThrow('cancelled');
    controller.abort();
    await rejection;
    expect(killProcessSpy).not.toHaveBeenCalled();
    await closeShellProcess(children[1], envOutput('/shared/bin'));
    expect((await kept).PATH).toMatch(/^\/shared\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('bounds retained capture bytes as well as the number of cached workspaces', async () => {
    process.env.ELEVENEX_SHELL_CACHE_BYTES = String(1024 * 1024);
    loadSystemPaths();
    await seedGlobalEnv();
    for (let i = 0; i < 32; i++) {
      const read = systemPaths.buildAugmentedEnvAsync({}, `/repo/large-${i}`);
      await closeShellProcess(
        children[i + 1],
        envOutput(`/large-${i}/bin`, `DATA=${'x'.repeat(50000)}\0`),
      );
      await read;
    }
    expect(
      (await systemPaths.buildAugmentedEnvAsync({}, '/repo/large-31')).PATH,
    ).toMatch(/^\/large-31\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(33);
    const evicted = systemPaths.buildAugmentedEnvAsync({}, '/repo/large-0');
    await closeShellProcess(children[33], envOutput('/recaptured/bin'));
    await evicted;
    expect(mockSpawn).toHaveBeenCalledTimes(34);
  });

  it('owns shutdown of active processes and queued reads', async () => {
    await seedGlobalEnv();
    const read = systemPaths.buildAugmentedEnvAsync({}, '/repo/closing');
    const rejected = expect(read).rejects.toThrow('shutting down');
    systemPaths.disposeShellEnvironment();
    await rejected;
    expect(killProcessSpy).toHaveBeenCalledWith(-children[1].pid, 'SIGKILL');
    expect(children[1].stdout.eventNames()).toEqual([]);
  });

  it('shares a two-shell bound across global and many unique cwd refreshes', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    const globalRefresh = systemPaths.refreshLoginShellEnv(true);
    for (let index = 0; index < 40; index++) {
      const env = systemPaths.buildAugmentedEnv(
        { PATH: '/base/bin' },
        `/repo/${index}`,
      );
      expect(env.PATH).toMatch(/^\/base\/bin:/);
    }

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockExecSync).not.toHaveBeenCalled();
    await drainCaptures();
    await globalRefresh;
    expect(mockSpawn).toHaveBeenCalledTimes(41);
  });

  it('coalesces the same queued cwd for sync and async callers', async () => {
    await seedGlobalEnv();
    systemPaths.buildAugmentedEnv({}, '/repo/block-a');
    systemPaths.buildAugmentedEnv({}, '/repo/block-b');
    for (let index = 0; index < 20; index++) {
      systemPaths.buildAugmentedEnv({}, '/repo/queued');
    }
    const first = systemPaths.buildAugmentedEnvAsync({}, '/repo/queued');
    const second = systemPaths.buildAugmentedEnvAsync({}, '/repo/queued');
    expect(mockSpawn).toHaveBeenCalledTimes(3);

    await closeShellProcess(children[1], envOutput('/block-a/bin'));
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    expect(mockSpawn.mock.calls[3][2].cwd).toBe('/repo/queued');
    await closeShellProcess(children[3], envOutput('/queued/bin'));
    expect((await first).PATH).toMatch(/^\/queued\/bin:/);
    expect((await second).PATH).toMatch(/^\/queued\/bin:/);
    await closeShellProcess(children[2], envOutput('/block-b/bin'));
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it.each(['new required capture', 'promoted optional capture'])(
    'runs a %s ahead of older background work while retaining coalescing',
    async (kind) => {
      await seedGlobalEnv();
      systemPaths.buildAugmentedEnv({}, '/repo/block-a');
      systemPaths.buildAugmentedEnv({}, '/repo/block-b');
      for (let index = 0; index < 8; index++) {
        systemPaths.buildAugmentedEnv({}, `/repo/background-${index}`);
      }
      if (kind === 'promoted optional capture') {
        systemPaths.buildAugmentedEnv({}, '/repo/priority');
      }
      const first = systemPaths.buildAugmentedEnvAsync({}, '/repo/priority');
      const second = systemPaths.buildAugmentedEnvAsync({}, '/repo/priority');
      expect(mockSpawn).toHaveBeenCalledTimes(3);

      await closeShellProcess(children[1], envOutput('/block-a/bin'));
      expect(mockSpawn).toHaveBeenCalledTimes(4);
      expect(mockSpawn.mock.calls[3][2].cwd).toBe('/repo/priority');
      await closeShellProcess(children[2], envOutput('/block-b/bin'));
      expect(mockSpawn.mock.calls[4][2].cwd).toBe('/repo/background-0');
      await closeShellProcess(children[3], envOutput('/priority/bin'));
      expect((await first).PATH).toMatch(/^\/priority\/bin:/);
      expect((await second).PATH).toMatch(/^\/priority\/bin:/);
      await drainCaptures(4);
      expect(
        mockSpawn.mock.calls.filter((call) => call[2].cwd === '/repo/priority'),
      ).toHaveLength(1);
      expect(mockSpawn).toHaveBeenCalledTimes(12);
    },
  );

  it('runs a coalesced global bootstrap ahead of older queued background work', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/block-a');
    systemPaths.buildAugmentedEnv({}, '/repo/block-b');
    for (let index = 0; index < 8; index++) {
      systemPaths.buildAugmentedEnv({}, `/repo/background-${index}`);
    }
    const first = systemPaths.refreshLoginShellEnv(true);
    const second = systemPaths.refreshLoginShellEnv(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await closeShellProcess(children[0], envOutput('/block-a/bin'));
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[2]).toHaveProperty('2.cwd', os.homedir());
    await closeShellProcess(children[1], envOutput('/block-b/bin'));
    expect(mockSpawn.mock.calls[3][2].cwd).toBe('/repo/background-0');
    await closeShellProcess(children[2], envOutput('/global/bin'));
    await Promise.all([first, second]);
    await drainCaptures(3);
    expect(mockSpawn).toHaveBeenCalledTimes(11);
  });

  it('coalesces a queued global capture and then captures an async caller cwd', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/block-a');
    systemPaths.buildAugmentedEnv({}, '/repo/block-b');
    const first = systemPaths.refreshLoginShellEnv(true);
    const second = systemPaths.refreshLoginShellEnv(true);
    const result = systemPaths.buildAugmentedEnvAsync({}, '/repo/async');
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await closeShellProcess(children[0], envOutput('/block-a/bin'));
    expect(mockSpawn.mock.calls[2]).toHaveProperty('2.cwd', os.homedir());
    await closeShellProcess(children[2], envOutput('/global/bin'));
    await Promise.all([first, second]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    expect(mockSpawn.mock.calls[3][2].cwd).toBe('/repo/async');
    await closeShellProcess(children[3], envOutput('/async/bin'));
    expect((await result).PATH).toMatch(/^\/async\/bin:/);
    await closeShellProcess(children[1], envOutput('/block-b/bin'));
  });

  it('settles async failed captures with fallback without immediately requeuing', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    const global = systemPaths.buildAugmentedEnvAsync({ PATH: '/base/bin' });
    children[0].emit('error', new Error('global capture failed'));
    expect((await global).PATH).toMatch(/^\/base\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await seedGlobalEnv();
    const cwd = systemPaths.buildAugmentedEnvAsync(
      { PATH: '/base/bin' },
      '/repo/fails',
    );
    children[2].emit('error', new Error('cwd capture failed'));
    expect((await cwd).PATH).toMatch(/^\/global\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('drops evicted queued background work and does not restore evicted running entries', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    for (let index = 0; index < 150; index++) {
      systemPaths.buildAugmentedEnv({}, `/repo/${index}`);
    }
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await drainCaptures();

    expect(mockSpawn.mock.calls.map((call) => call[2].cwd)).toEqual([
      '/repo/0',
      '/repo/1',
      ...Array.from({ length: 64 }, (_, index) => `/repo/${index + 86}`),
    ]);
    const evicted = systemPaths.buildAugmentedEnv(
      { PATH: '/base/bin' },
      '/repo/0',
    );
    expect(evicted.PATH).toMatch(/^\/base\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(67);
    await closeShellProcess(children[66], envOutput('/recaptured/bin'));
  });

  it('keeps an async queued capture through eviction and returns its own env directly', async () => {
    await seedGlobalEnv();
    systemPaths.buildAugmentedEnv({}, '/repo/block-a');
    systemPaths.buildAugmentedEnv({}, '/repo/block-b');
    const result = systemPaths.buildAugmentedEnvAsync(
      { CALLER: 'kept', PWD: '/backend' },
      '/repo/required',
    );
    for (let index = 0; index < 100; index++) {
      systemPaths.buildAugmentedEnv({}, `/repo/background-${index}`);
    }

    await closeShellProcess(children[1], envOutput('/block-a/bin'));
    expect(mockSpawn.mock.calls[3][2].cwd).toBe('/repo/required');
    await closeShellProcess(children[3], envOutput('/required/bin'));
    const callsAfterCapture = mockSpawn.mock.calls.length;
    expect(await result).toMatchObject({
      PATH: expect.stringMatching(/^\/required\/bin:/),
      CALLER: 'kept',
      PWD: '/repo/required',
    });
    // Consuming an evicted capture must not queue a second capture via the
    // synchronous fallback builder.
    expect(mockSpawn).toHaveBeenCalledTimes(callsAfterCapture);
    await closeShellProcess(children[2], envOutput('/block-b/bin'));
    await drainCaptures(4);
    expect(
      mockSpawn.mock.calls.filter((call) => call[2].cwd === '/repo/required'),
    ).toHaveLength(1);
  });

  it('returns each async caller its captured env under cache churn', async () => {
    await seedGlobalEnv();
    const results = Array.from({ length: 100 }, (_, index) =>
      systemPaths.buildAugmentedEnvAsync({}, `/repo/async-${index}`),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    await drainCaptures(1);
    const envs = await Promise.all(results);
    envs.forEach((env, index) => {
      expect(env.PATH).toMatch(new RegExp(`^/repo/async-${index}/bin:`));
      expect(env.PWD).toBe(`/repo/async-${index}`);
    });
    expect(mockSpawn).toHaveBeenCalledTimes(101);
  });

  it.each([
    'timeout',
    'process error',
    'stdio error',
    'overflow',
    'exit failure',
    'signal',
  ])(
    'releases capacity and discards partial env on %s without waiting for close',
    async (failure) => {
      mockSpawn.mockImplementation(() => createShellProcess());
      systemPaths.buildAugmentedEnv({}, '/repo/fails');
      systemPaths.buildAugmentedEnv({}, '/repo/other');
      systemPaths.buildAugmentedEnv({}, '/repo/queued');
      const failed = children[0];
      failed.stdout.emit('data', Buffer.from(envOutput('/partial/bin')));
      switch (failure) {
        case 'timeout':
          await jest.advanceTimersByTimeAsync(15_000);
          break;
        case 'process error':
          failed.emit('error', new Error('spawn failed'));
          break;
        case 'stdio error':
          failed.stdout.emit('error', new Error('read failed'));
          break;
        case 'overflow':
          failed.stdout.emit('data', Buffer.alloc(1024 * 1024));
          break;
        case 'exit failure':
          failed.emit('exit', 1, null);
          break;
        case 'signal':
          failed.emit('exit', null, 'SIGTERM');
          break;
      }
      await jest.advanceTimersByTimeAsync(0);
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(process.kill).toHaveBeenCalledWith(-failed.pid, 'SIGKILL');
      expect(failed.eventNames()).toEqual([]);
      expect(failed.stdout.eventNames()).toEqual([]);
      expect(failed.stdout.destroy).toHaveBeenCalledTimes(1);

      failed.emit('close', 0);
      failed.stdout.emit('data', Buffer.from(envOutput('/late/bin')));
      const env = systemPaths.buildAugmentedEnv(
        { PATH: '/base/bin' },
        '/repo/fails',
      );
      expect(env.PATH).toMatch(/^\/base\/bin:/);
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      await closeShellProcess(children[2], envOutput('/queued/bin'));
      if (failure !== 'timeout') {
        await closeShellProcess(children[1], envOutput('/other/bin'));
      }
    },
  );

  it('settles synchronous spawn failures without leaking a slot or rejecting callers', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn threw');
    });
    const failed = systemPaths.refreshLoginShellEnv(true);
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/a');
    systemPaths.buildAugmentedEnv({}, '/repo/b');
    await expect(failed).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    await closeShellProcess(children[0], envOutput('/a/bin'));
    await closeShellProcess(children[1], envOutput('/b/bin'));
  });

  it('falls back to signalling only the child if its isolated group is gone', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    jest.mocked(process.kill).mockImplementationOnce(() => {
      throw new Error('no such process group');
    });
    systemPaths.buildAugmentedEnv({}, '/repo/error');
    children[0].emit('error', new Error('failed'));
    await Promise.resolve();
    expect(process.kill).toHaveBeenNthCalledWith(
      1,
      -children[0].pid,
      'SIGKILL',
    );
    expect(process.kill).toHaveBeenNthCalledWith(2, children[0].pid, 'SIGKILL');
  });

  it('does not signal a missing PID after a failed spawn', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/missing');
    Object.assign(children[0], { pid: undefined });
    children[0].emit('error', new Error('ENOENT'));
    await Promise.resolve();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('preserves the user shell and captured user exports in cwd baselines', async () => {
    process.env.SHELL = '/custom/user-shell';
    mockSpawn.mockImplementation(() => createShellProcess());
    const global = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[0],
      envOutput(
        '/global/bin',
        `CUSTOM_HOME=/tools\0PWD=/stale\0OLDPWD=/old\0SHLVL=9\0`,
      ),
    );
    await global;
    systemPaths.buildAugmentedEnv({}, '/repo/local');

    const expectedEnv: unknown = expect.objectContaining({
      HOME: os.homedir(),
      SHELL: '/custom/user-shell',
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      PATH: '/global/bin',
      PS1: '',
      ELEVENEX_TEST_ENV: '1',
      CUSTOM_HOME: '/tools',
    });
    expect(mockSpawn).toHaveBeenLastCalledWith(
      '/custom/user-shell',
      ['-i', '-l', '-c', expect.stringContaining(envBoundary)],
      {
        cwd: '/repo/local',
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: expectedEnv,
      },
    );
    await closeShellProcess(
      children[1],
      envOutput('/local/bin', `CUSTOM_HOME=/local-tools\0`),
    );
    expect(
      systemPaths.buildAugmentedEnv({ CUSTOM_HOME: '/caller' }, '/repo/local'),
    ).toMatchObject({
      CUSTOM_HOME: '/caller',
      ELEVENEX_TEST_ENV: '1',
      PWD: '/repo/local',
      PATH: expect.stringMatching(/^\/local\/bin:/),
    });
  });

  it('keeps user identity in global and cold cwd captures without inheriting stale shell state', async () => {
    process.env.HOME = '/home/remote-user';
    jest
      .spyOn(jest.requireActual<typeof os>('os'), 'homedir')
      .mockReturnValue('/home/remote-user');
    process.env.USER = 'remote-user';
    process.env.LOGNAME = 'remote-user';
    process.env.SHELL = '/bin/bash';
    process.env.PATH = '/stale/fnm_multishells/old/bin';
    process.env.NVM_DIR = '/custom/nvm';
    process.env.CUSTOM_BOOTSTRAP_LOCATION = '/company/setup';
    process.env.NVM_BIN = '/stale/nvm/bin';
    process.env.FNM_MULTISHELL_PATH = '/stale/fnm_multishells/old';
    mockSpawn.mockImplementation(() => createShellProcess());

    const global = systemPaths.refreshLoginShellEnv(true);
    systemPaths.buildAugmentedEnv({}, '/repo/cold');

    const cleanPath: unknown = expect.not.stringContaining('/stale/');
    const expectedEnv: unknown = expect.objectContaining({
      HOME: '/home/remote-user',
      USER: 'remote-user',
      LOGNAME: 'remote-user',
      SHELL: '/bin/bash',
      PS1: '',
      NVM_DIR: '/custom/nvm',
      CUSTOM_BOOTSTRAP_LOCATION: '/company/setup',
      PATH: cleanPath,
    });
    for (const [index, cwd] of ['/home/remote-user', '/repo/cold'].entries()) {
      expect(mockSpawn).toHaveBeenNthCalledWith(
        index + 1,
        '/bin/bash',
        ['-i', '-l', '-c', expect.stringContaining(envBoundary)],
        {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: expectedEnv,
        },
      );
      expect(mockSpawn.mock.calls[index]).not.toHaveProperty('2.env.NVM_BIN');
      expect(mockSpawn.mock.calls[index]).not.toHaveProperty(
        '2.env.FNM_MULTISHELL_PATH',
      );
    }
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await closeShellProcess(
      children[0],
      envOutput('/home/remote-user/.nvm/bin'),
    );
    await closeShellProcess(children[1], envOutput('/repo/node/bin'));
    await global;
    expect(process.env.PATH).toContain('/home/remote-user/.nvm/bin');
  });

  it('preserves custom shell/configuration locations in global and worktree captures', async () => {
    const context = {
      SHELL: '/bin/bash',
      ZDOTDIR: '/custom/zsh',
      XDG_CONFIG_HOME: '/custom/config',
      XDG_DATA_HOME: '/custom/data',
      XDG_STATE_HOME: '/custom/state',
      XDG_CACHE_HOME: '/custom/cache',
      XDG_RUNTIME_DIR: '/custom/runtime',
    };
    Object.assign(process.env, context);
    mockSpawn.mockImplementation(() => createShellProcess());
    const first = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[0],
      envOutput('/global/bin', 'XDG_DATA_HOME=/captured/data\0'),
    );
    await first;
    systemPaths.buildAugmentedEnv({}, '/repo/context');
    await closeShellProcess(children[1], envOutput('/repo/bin'));
    const next = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(children[2], envOutput('/global/bin'));
    await next;
    for (const [index, expected] of [context, context, context].entries()) {
      expect(mockSpawn.mock.calls[index]).toHaveProperty('0', '/bin/bash');
      for (const [key, value] of Object.entries(expected)) {
        expect(mockSpawn.mock.calls[index]).toHaveProperty(
          ['2', 'env', key],
          value,
        );
      }
    }
  });

  it('does not reuse a shell-projected startup location as a launch-time override', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    const first = systemPaths.refreshLoginShellEnv(true);
    await closeShellProcess(
      children[0],
      envOutput('/global/bin', 'ZDOTDIR=/captured/zsh\0'),
    );
    await first;
    expect(process.env.ZDOTDIR).toBe('/captured/zsh');
    const next = systemPaths.refreshLoginShellEnv(true);
    expect(mockSpawn.mock.lastCall).not.toHaveProperty('2.env.ZDOTDIR');
    await closeShellProcess(children[1], envOutput('/global/bin'));
    await next;
    expect(process.env.ZDOTDIR).toBeUndefined();
  });

  it('rejects oversized startup inputs before spawning and retains the last good capture', async () => {
    await seedGlobalEnv();
    process.env.ZDOTDIR = 'private-startup-location'.repeat(4000);
    await systemPaths.refreshLoginShellEnv(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(systemPaths.buildAugmentedEnv({}).PATH).toContain('/global/bin');
  });

  it('ignores chatty startup output and malformed keys, preserving UTF-8 across chunks', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/chatty');
    const output = Buffer.from(
      `BANNER=ignored\nnoise\n${envOutput('/local/bin', `CUSTOM=héllo=世界\0MULTILINE=first\nPATH=/wrong/bin\nFAKE_SECRET=value\nlast=世界\0EMPTY=\0BANNER_TEXT=${envBoundary}\x001INVALID=ignored\0BAD-KEY=ignored\0`)}logout banner\n`,
    );
    const split = output.indexOf(Buffer.from('é')) + 1;
    children[0].stdout.emit('data', output.subarray(0, split));
    children[0].stdout.emit('data', output.subarray(split));
    children[0].emit('close', 0);
    await Promise.resolve();

    const env = systemPaths.buildAugmentedEnv({}, '/repo/chatty');
    expect(env.CUSTOM).toBe('héllo=世界');
    expect(env.MULTILINE).toBe(
      'first\nPATH=/wrong/bin\nFAKE_SECRET=value\nlast=世界',
    );
    expect(env.PATH).not.toContain('/wrong/bin');
    expect(env.FAKE_SECRET).toBeUndefined();
    expect(env.EMPTY).toBe('');
    expect(env.BANNER_TEXT).toBe(envBoundary);
    expect(env.BANNER).toBeUndefined();
    expect(env['1INVALID']).toBeUndefined();
    expect(env['BAD-KEY']).toBeUndefined();
  });

  it.each([
    'BANNER=not-an-env\nPATH=/wrong/bin\n',
    `${envBoundary}not an env\x001BAD=value\0`,
    `${envBoundary}PATH=/truncated/bin`,
  ])('rejects incomplete or malformed captures: %s', async (output) => {
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/malformed');
    await closeShellProcess(children[0], output);
    expect(
      systemPaths.buildAugmentedEnv({ PATH: '/base/bin' }, '/repo/malformed')
        .PATH,
    ).toMatch(/^\/base\/bin:/);
  });
});

describe('system-paths Windows env handling', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'win32',
    });
    loadSystemPaths();
  });

  it('does not spawn a POSIX login shell when refreshing env', async () => {
    await systemPaths.refreshLoginShellEnv(true);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('uses the inherited Windows path without shell-env refreshes', async () => {
    const baseEnv = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
    };

    const syncEnv = systemPaths.buildAugmentedEnv(baseEnv, 'C:\\repo');
    const asyncEnv = await systemPaths.buildAugmentedEnvAsync(
      baseEnv,
      'C:\\repo',
    );

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(syncEnv.Path).toBe(baseEnv.Path);
    expect(syncEnv.PATH).toBeUndefined();
    expect(asyncEnv.Path).toBe(baseEnv.Path);
    expect(asyncEnv.PATH).toBeUndefined();
  });

  it('splits and joins PATH with the Windows delimiter', () => {
    const pathValue = systemPaths.buildAugmentedPath(
      'C:\\Windows\\System32;C:\\Tools',
      'C:\\Tools;D:\\bin',
    );

    expect(pathValue).toBe('C:\\Windows\\System32;C:\\Tools;D:\\bin');
  });

  it('retains only the preferred FNM multishell directory on Windows', () => {
    expect(
      systemPaths.buildAugmentedPath(
        'C:\\Windows\\System32;C:\\fnm_multishells\\current;C:\\Tools',
        'C:\\fnm_multishells\\old;C:\\Tools',
      ),
    ).toBe('C:\\Windows\\System32;C:\\fnm_multishells\\current;C:\\Tools');
  });

  it('runs generic command shims through the Windows shell', () => {
    expect(systemPaths.buildSpawnCommand('C:\\Tools\\codex.cmd')).toEqual({
      command: '"C:\\Tools\\codex.cmd"',
      shell: true,
    });
    expect(systemPaths.buildSpawnCommand('C:\\Tools\\codex.BAT')).toEqual({
      command: '"C:\\Tools\\codex.BAT"',
      shell: true,
    });
  });

  it('spawns native Windows executables directly', () => {
    expect(systemPaths.buildSpawnCommand('C:\\Tools\\codex.exe')).toEqual({
      command: 'C:\\Tools\\codex.exe',
      shell: false,
    });
  });

  it.each(['.EXE', '.CMD', '.BAT'])(
    'finds Windows %s candidates before extensionless POSIX shims',
    (extension) => {
      process.env.Path = 'C:\\Tools';
      delete process.env.PATH;
      process.env.PATHEXT = '.EXE;.CMD;.BAT';
      const executable = path.join('C:\\Tools', `codex${extension}`);
      const shim = path.join('C:\\Tools', 'codex');
      jest
        .spyOn(jest.requireActual<typeof fs>('fs'), 'accessSync')
        .mockImplementation((candidate) => {
          if (candidate !== executable && candidate !== shim) {
            throw new Error('unavailable');
          }
        });

      expect(systemPaths.findBinary('codex')).toBe(executable);
    },
  );

  it('respects Windows PATH directory order before PATHEXT priority', () => {
    process.env.PATH = 'C:\\First;C:\\Second';
    process.env.PATHEXT = '.EXE;.CMD;.BAT';
    const first = path.join('C:\\First', 'codex.CMD');
    const second = path.join('C:\\Second', 'codex.EXE');
    jest
      .spyOn(jest.requireActual<typeof fs>('fs'), 'accessSync')
      .mockImplementation((candidate) => {
        if (candidate !== first && candidate !== second) {
          throw new Error('unavailable');
        }
      });

    expect(systemPaths.findBinary('codex')).toBe(first);
  });

  it.each([undefined, '.BAT;.CMD;.EXE'])(
    'uses default or configured PATHEXT order: %s',
    (pathext) => {
      process.env.PATH = 'C:\\Tools';
      if (pathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = pathext;
      const access = jest
        .spyOn(jest.requireActual<typeof fs>('fs'), 'accessSync')
        .mockImplementation(() => undefined);
      const expected = path.join(
        'C:\\Tools',
        `codex${pathext ? '.BAT' : '.COM'}`,
      );

      expect(systemPaths.findBinary('codex')).toBe(expected);
      expect(access).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves explicit extensions and the bare-name fallback on Windows', () => {
    process.env.PATH = 'C:\\Tools';
    process.env.PATHEXT = '.CMD;.EXE';
    const executable = path.join('C:\\Tools', 'codex.exe');
    const bare = path.join('C:\\Tools', 'pi');
    jest
      .spyOn(jest.requireActual<typeof fs>('fs'), 'accessSync')
      .mockImplementation((candidate) => {
        if (candidate !== executable && candidate !== bare) {
          throw new Error('unavailable');
        }
      });

    expect(systemPaths.findBinary('codex.exe')).toBe(executable);
    expect(systemPaths.findBinary('pi')).toBe(bare);
  });
});

describePosix('system-paths POSIX process handling', () => {
  it('spawns launchers directly', () => {
    expect(systemPaths.buildSpawnCommand('/usr/local/bin/codex')).toEqual({
      command: '/usr/local/bin/codex',
      shell: false,
    });
  });
});

describe('buildTmuxInlineEnvPrefix', () => {
  it('inlines only critical env vars and requested extras by default', () => {
    const prefix = systemPaths.buildTmuxInlineEnvPrefix(
      {
        PATH: '/repo/bin',
        LANG: 'en_US.UTF-8',
        ELEVENEX_SESSION_ID: '42',
        ELEVENEX_ACTION_TOKEN: 'secret',
      },
      ['ELEVENEX_SESSION_ID'],
    );

    expect(prefix).toContain("PATH='/repo/bin'");
    expect(prefix).toContain("LANG='en_US.UTF-8'");
    expect(prefix).toContain("ELEVENEX_SESSION_ID='42'");
    expect(prefix).not.toContain('ELEVENEX_ACTION_TOKEN');
  });

  it('can inline the full env with shell-safe quoting for generic tmux actions', () => {
    const prefix = systemPaths.buildTmuxInlineEnvPrefix(
      {
        PATH: '/repo/bin',
        ELEVENEX_ACTION_TOKEN: 'abc 123',
        ELEVENEX_ACTION_QUOTED: "it's ok",
        'ELEVENEX-INVALID-KEY': 'ignored',
      },
      { mode: 'full' },
    );

    expect(prefix).toContain("PATH='/repo/bin'");
    expect(prefix).toContain("ELEVENEX_ACTION_TOKEN='abc 123'");
    expect(prefix).toContain("ELEVENEX_ACTION_QUOTED='it'\\''s ok'");
    expect(prefix).not.toContain('ELEVENEX-INVALID-KEY');
  });
});
