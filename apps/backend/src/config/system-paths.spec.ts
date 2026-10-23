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
  process.env = { ...originalEnv };
  children = [];
  jest.spyOn(process, 'kill').mockReturnValue(true);
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
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function envOutput(binPath: string): string {
  return `${envBoundary}PATH=${binPath}\nELEVENEX_TEST_ENV=1\n`;
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
  await Promise.resolve();
  await Promise.resolve();
}

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
    expect(mockSpawn.mock.calls[2][2].cwd).toBeUndefined();
    await closeShellProcess(children[1], envOutput('/block-b/bin'));
    expect(mockSpawn.mock.calls[3][2].cwd).toBe('/repo/background-0');
    await closeShellProcess(children[2], envOutput('/global/bin'));
    await Promise.all([first, second]);
    await drainCaptures(3);
    expect(
      mockSpawn.mock.calls.filter((call) => call[2].cwd === undefined),
    ).toHaveLength(1);
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
    expect(mockSpawn.mock.calls[2][2].cwd).toBeUndefined();
    await closeShellProcess(children[2], envOutput('/global/bin'));
    await Promise.all([first, second]);
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
          await jest.advanceTimersByTimeAsync(5_000);
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
      await Promise.resolve();
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
      `${envOutput('/global/bin')}CUSTOM_HOME=/tools\nPWD=/stale\nOLDPWD=/old\nSHLVL=9\n`,
    );
    await global;
    systemPaths.buildAugmentedEnv({}, '/repo/local');

    expect(mockSpawn).toHaveBeenLastCalledWith(
      '/custom/user-shell',
      ['-i', '-l', '-c', expect.stringContaining(envBoundary)],
      {
        cwd: '/repo/local',
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: '/global/bin',
          PS1: '',
          ELEVENEX_TEST_ENV: '1',
          CUSTOM_HOME: '/tools',
        },
      },
    );
    await closeShellProcess(
      children[1],
      `${envOutput('/local/bin')}CUSTOM_HOME=/local-tools\n`,
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

  it('ignores chatty startup output and malformed keys, preserving UTF-8 across chunks', async () => {
    mockSpawn.mockImplementation(() => createShellProcess());
    systemPaths.buildAugmentedEnv({}, '/repo/chatty');
    const output = Buffer.from(
      `BANNER=ignored\nnoise\n${envOutput('/local/bin')}CUSTOM=héllo=世界\n1INVALID=ignored\nBAD-KEY=ignored\n`,
    );
    const split = output.indexOf(Buffer.from('é')) + 1;
    children[0].stdout.emit('data', output.subarray(0, split));
    children[0].stdout.emit('data', output.subarray(split));
    children[0].emit('close', 0);
    await Promise.resolve();

    const env = systemPaths.buildAugmentedEnv({}, '/repo/chatty');
    expect(env.CUSTOM).toBe('héllo=世界');
    expect(env.BANNER).toBeUndefined();
    expect(env['1INVALID']).toBeUndefined();
    expect(env['BAD-KEY']).toBeUndefined();
  });

  it.each([
    'BANNER=not-an-env\nPATH=/wrong/bin\n',
    `${envBoundary}not an env\n1BAD=value\n`,
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
