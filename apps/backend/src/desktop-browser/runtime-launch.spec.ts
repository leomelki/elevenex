import { chromium, type BrowserContext } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { launchRuntimeBrowser } from './runtime-launch.js';
import { browserStartError } from './runtime-start-error.js';

describe('Browser host startup and recovery', () => {
  let root: string, configured: string, managed: string;
  const launch = jest.spyOn(chromium, 'launchPersistentContext');
  const executable = jest.spyOn(chromium, 'executablePath');
  const userId = process.getuid ? jest.spyOn(process, 'getuid') : undefined;
  const install = jest.fn<Promise<void>, []>();
  // The launcher only returns this opaque context; page initialization belongs to the pool.
  const context = {} as BrowserContext;
  const options = {
    headless: true,
    chromiumSandbox: true,
    proxy: { server: 'http://private-proxy:1234' },
  };
  const run = (signal = new AbortController().signal) =>
    launchRuntimeBrowser(
      join(root, 'app'),
      join(root, 'profile'),
      options,
      install,
      signal,
    );
  const provision = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  };
  beforeEach(async () => {
    userId?.mockReturnValue(1000);
    root = await mkdtemp(join(tmpdir(), 'browser-launch-'));
    configured = join(
      root,
      'configured',
      'chromium-1228',
      'chrome-linux',
      'chrome',
    );
    managed = join(root, 'app', 'chromium-1228', 'chrome-linux', 'chrome');
    executable.mockReturnValue(configured);
    launch
      .mockReset()
      .mockRejectedValue(new Error('Chrome distribution is not found'));
    install.mockReset().mockResolvedValue();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  afterAll(() => {
    launch.mockRestore();
    executable.mockRestore();
    userId?.mockRestore();
  });

  it('uses provisioned app Chromium without downloading or changing the sandbox/proxy', async () => {
    await provision(managed);
    launch.mockResolvedValue(context);
    expect(await run()).toBe(context);
    expect(install).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(join(root, 'profile'), {
      ...options,
      executablePath: managed,
    });
  });
  it('uses the configured Playwright cache on an offline host without installing', async () => {
    await provision(configured);
    launch.mockResolvedValue(context);
    expect(await run()).toBe(context);
    expect(install).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith(join(root, 'profile'), {
      ...options,
      executablePath: configured,
    });
  });
  it('retains the installed Chrome fallback without downloading', async () => {
    launch.mockResolvedValue(context);
    expect(await run()).toBe(context);
    expect(launch).toHaveBeenCalledWith(join(root, 'profile'), {
      ...options,
      channel: 'chrome',
    });
    expect(install).not.toHaveBeenCalled();
  });
  it.each([
    [
      'error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file',
      'dependencies',
    ],
    ['Host system is missing dependencies to run browsers', 'dependencies'],
    ['Library not loaded: @rpath/libExample.dylib', 'dependencies'],
    ['No usable sandbox!', 'sandbox'],
    ['Running as root without --no-sandbox is not supported', 'root'],
    ['Failed to move to new namespace: Operation not permitted', 'sandbox'],
    ["libc.so.6: version `GLIBC_2.38' not found", 'incompatible'],
    ['spawn chrome ENOEXEC: Exec format error', 'incompatible'],
    ['spawn chrome EACCES', 'permissions'],
    [
      'Failed to create a ProcessSingleton for your profile directory',
      'profile',
    ],
  ])(
    'does not reinstall an existing browser for host failure: %s',
    async (message, reason) => {
      await provision(managed);
      launch.mockRejectedValueOnce(
        new Error(message + '\nsecret-proxy-credentials'),
      );
      await expect(run()).rejects.toMatchObject({ reason });
      expect(install).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledTimes(2);
      const error = browserStartError(
        new Error(message + '\nsecret-proxy-credentials'),
      );
      expect(error.message).not.toContain('secret-proxy-credentials');
    },
  );
  it('installs a missing distribution once and classifies the subsequent native launch failure', async () => {
    launch
      .mockRejectedValueOnce(new Error('Chrome distribution is not found'))
      .mockRejectedValueOnce(
        new Error('error while loading shared libraries: libgbm.so.1'),
      );
    await expect(run()).rejects.toMatchObject({ reason: 'dependencies' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenLastCalledWith(join(root, 'profile'), {
      ...options,
      executablePath: managed,
    });
  });
  it('does not retain failed startup state after the host is repaired', async () => {
    await provision(managed);
    launch.mockRejectedValueOnce(
      new Error('error while loading shared libraries: libatk-1.0.so.0'),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'dependencies' });
    launch.mockResolvedValue(context);
    expect(await run()).toBe(context);
    expect(install).not.toHaveBeenCalled();
  });
  it('reports a failed download without leaking installer output', async () => {
    install.mockRejectedValue(new Error('proxy-url-with-password'));
    await expect(run()).rejects.toMatchObject({ reason: 'download' });
    await expect(run()).rejects.not.toThrow('proxy-url-with-password');
  });
  it('does not launch after shutdown interrupts installation', async () => {
    const controller = new AbortController();
    install.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await expect(run(controller.signal)).rejects.toThrow();
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('withholds unclassified private native output', () => {
    expect(
      browserStartError(new Error('secret-page-output')).message,
    ).not.toContain('secret-page-output');
  });
});
