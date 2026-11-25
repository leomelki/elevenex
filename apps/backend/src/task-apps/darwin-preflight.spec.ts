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

  it('reports a denied SSH desktop handoff separately from a signed-out desktop', async () => {
    mockResults.push(failed(20), failed(1));
    await expect(DarwinAppDisplay.preflight()).rejects.toMatchObject({
      issue: 'macos-desktop-connection', message: expect.stringContaining('SSH engine'),
    });
  });

  it('keeps the native locked or unavailable desktop result', async () => {
    mockResults.push(failed(20), failed(20));
    await expect(DarwinAppDisplay.preflight()).rejects.toMatchObject({ issue: 'macos-session' });
  });

  it('preserves a permission failure reported by the graphical helper', async () => {
    mockResults.push(failed(20), failed(21));
    await expect(DarwinAppDisplay.preflight()).rejects.toMatchObject({ issue: 'macos-screen-recording' });
  });

  it('uses the graphical context when the handoff succeeds', async () => {
    mockResults.push(failed(20), null);
    await expect(DarwinAppDisplay.preflight()).resolves.toBe('user');
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

  it('opens the setup app through LaunchServices without an SSH audit-session switch', async () => {
    mockResults.push(null);
    await DarwinAppDisplay.openSetupSettings();
    expect(execFile).toHaveBeenLastCalledWith('/usr/bin/open',
      ['-a', '/test/runtime/bin/Elevenex Agent.app'], expect.any(Object), expect.any(Function));
  });
});
