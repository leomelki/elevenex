const mockResults: (Error | null)[] = [];

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execFile: jest.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== 'function') throw new Error('Expected execFile callback');
    callback(mockResults.shift() ?? null, '', '');
  }),
}));

import { DarwinAppDisplay } from './darwin-display.js';
import { execFile } from 'node:child_process';

const failed = (code: number) => Object.assign(new Error('Host check failed'), { code });

describe('macOS app host preflight', () => {
  const root = process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
  beforeEach(() => {
    process.env.ELEVENEX_BACKEND_RUNTIME_ROOT = '/test/runtime';
    mockResults.length = 0;
  });
  afterEach(() => {
    if (root === undefined) delete process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
    else process.env.ELEVENEX_BACKEND_RUNTIME_ROOT = root;
  });

  it('reports a failed agent desktop connection separately from permissions', async () => {
    mockResults.push(failed(25));
    await expect(DarwinAppDisplay.preflight()).rejects.toMatchObject({
      issue: 'macos-desktop-connection', message: expect.stringContaining('could not connect'),
    });
  });

  it('keeps the native locked or unavailable desktop result', async () => {
    mockResults.push(failed(20));
    await expect(DarwinAppDisplay.preflight()).rejects.toMatchObject({ issue: 'macos-session' });
  });

  it('preserves a permission failure reported by the graphical helper', async () => {
    mockResults.push(failed(21));
    await expect(DarwinAppDisplay.preflight()).rejects.toMatchObject({ issue: 'macos-screen-recording' });
  });

  it('uses the native LaunchServices path for the check and the stream', async () => {
    mockResults.push(null);
    await expect(DarwinAppDisplay.preflight()).resolves.toBe('direct');
    expect(execFile).toHaveBeenLastCalledWith(
      '/test/runtime/bin/Elevenex Agent.app/Contents/MacOS/Elevenex Agent',
      ['--check'], expect.objectContaining({ timeout: 8000 }), expect.any(Function));
    expect(DarwinAppDisplay.launchCommand({ executable: '/tool/node', args: ['app with spaces'] }, 'direct')).toEqual({
      executable: '/test/runtime/bin/Elevenex Agent.app/Contents/MacOS/Elevenex Agent',
      args: ['--launch-desktop', '/tool/node', 'app with spaces'],
    });
  });

  it('reveals only the installed helper and returns its path when Finder cannot open', async () => {
    mockResults.push(null);
    await expect(DarwinAppDisplay.revealSetupHelper()).resolves.toEqual({
      path: '/test/runtime/bin/Elevenex Agent.app', revealed: true,
    });
    expect(execFile).toHaveBeenLastCalledWith('/usr/bin/open',
      ['-R', '/test/runtime/bin/Elevenex Agent.app'], expect.any(Object), expect.any(Function));
    mockResults.push(failed(1));
    await expect(DarwinAppDisplay.revealSetupHelper()).resolves.toEqual({
      path: '/test/runtime/bin/Elevenex Agent.app', revealed: false,
    });
  });

  it('opens a fresh setup instance from the exact runtime, rather than reusing an older bundle with the same ID', async () => {
    mockResults.push(null);
    await DarwinAppDisplay.openSetupSettings();
    expect(execFile).toHaveBeenLastCalledWith('/usr/bin/open',
      ['-n', '-a', '/test/runtime/bin/Elevenex Agent.app', '--args', '--setup'], expect.any(Object), expect.any(Function));
  });
});
