import { EventEmitter } from 'node:events';
import { execSync, spawn } from 'child_process';
import { buildAugmentedEnv } from './system-paths.js';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

type MockShellProcess = EventEmitter & {
  stdout: EventEmitter;
  kill: jest.Mock;
};

const mockExecSync = jest.mocked(execSync);
const mockSpawn = jest.mocked(spawn);
const envBoundary = '>>>ELEVENEX_ENV_BOUNDARY<<<';

function envOutput(binPath: string): string {
  return `${envBoundary}PATH=${binPath}\nELEVENEX_TEST_ENV=1\n`;
}

function createShellProcess(): MockShellProcess {
  const child = new EventEmitter() as MockShellProcess;
  child.stdout = new EventEmitter();
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

describe('system-paths per-cwd env cache', () => {
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.resetAllMocks();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('returns stale per-cwd cache immediately while a single async refresh runs', async () => {
    const cwd = '/repo/stale-returns-immediately';
    const baseEnv = { PATH: '/base/bin' };
    mockExecSync.mockReturnValue(envOutput('/cached/bin'));

    const coldResult = buildAugmentedEnv(baseEnv, cwd);

    expect(coldResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockExecSync).toHaveBeenCalledTimes(1);

    const refreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(refreshProcess as never);
    nowSpy.mockReturnValue(60_001);

    const staleResult = buildAugmentedEnv(baseEnv, cwd);

    expect(staleResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(60_100);

    const repeatedStaleResult = buildAugmentedEnv(baseEnv, cwd);

    expect(repeatedStaleResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(60_200);
    await closeShellProcess(refreshProcess, envOutput('/fresh/bin'));

    const refreshedResult = buildAugmentedEnv(baseEnv, cwd);

    expect(refreshedResult.PATH).toMatch(/^\/fresh\/bin:/);
  });

  it('throttles completed failed async refresh attempts for one minute', async () => {
    const cwd = '/repo/failed-refresh-throttle';
    const baseEnv = { PATH: '/base/bin' };
    mockExecSync.mockReturnValue(envOutput('/cached/bin'));

    buildAugmentedEnv(baseEnv, cwd);

    const failedRefreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(failedRefreshProcess as never);
    nowSpy.mockReturnValue(60_001);

    const staleResult = buildAugmentedEnv(baseEnv, cwd);

    expect(staleResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(60_002);
    await closeShellProcess(failedRefreshProcess, 'not an env line\n');

    const throttledResult = buildAugmentedEnv(baseEnv, cwd);

    expect(throttledResult.PATH).toMatch(/^\/cached\/bin:/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const nextRefreshProcess = createShellProcess();
    mockSpawn.mockReturnValue(nextRefreshProcess as never);
    nowSpy.mockReturnValue(120_003);

    buildAugmentedEnv(baseEnv, cwd);

    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await closeShellProcess(nextRefreshProcess, envOutput('/fresh/bin'));
  });
});
