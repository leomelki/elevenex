import * as commands from './process.js';
import * as diagnostics from './diagnostics.js';
import { browserFontsAvailable, browserLibraries } from './diagnostics.js';
import {
  browserStartError,
  RuntimeBrowserStartError,
  diagnoseBrowserStartFailure,
} from '../desktop-browser/runtime-start-error.js';

const probe = jest.spyOn(commands, 'probeHostCommand');
afterEach(() => probe.mockReset());
afterAll(() => probe.mockRestore());

it('accepts a working loader without consulting ldd (including nix-ld)', async () => {
  probe.mockResolvedValue({ code: 0, output: 'Chromium 149' });
  expect(await browserLibraries('/browser')).toEqual([]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledWith('/browser', ['--version'], undefined);
});
it('lists bounded, validated missing sonames after an actual loader failure', async () => {
  probe
    .mockResolvedValueOnce({
      code: 127,
      output:
        '/browser: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file',
    })
    .mockResolvedValueOnce({
      code: 0,
      output:
        ' libatk-1.0.so.0 => not found\n libgbm.so.1 => not found\n secret/url => not found\n libatk-1.0.so.0 => not found\n',
    });
  expect(await browserLibraries('/browser')).toEqual([
    'libatk-1.0.so.0',
    'libgbm.so.1',
  ]);
});
it('keeps the loader diagnosis when ldd is unavailable and never guesses dependencies from unrelated output', async () => {
  probe
    .mockResolvedValueOnce({
      code: 127,
      output: 'error while loading shared libraries: libgbm.so.1: missing',
    })
    .mockResolvedValueOnce({ code: null, output: '' });
  expect(await browserLibraries('/browser')).toEqual(['libgbm.so.1']);
  probe.mockResolvedValue({ code: 1, output: 'GLIBC_2.38 not found' });
  expect(await browserLibraries('/browser')).toEqual([]);
});
it('treats absent fontconfig and empty font matches as missing fonts', async () => {
  probe
    .mockResolvedValueOnce({ code: null, output: '' })
    .mockResolvedValueOnce({ code: 0, output: '' })
    .mockResolvedValueOnce({ code: 0, output: '/fonts/font.ttf' });
  expect(await browserFontsAvailable()).toBe(false);
  expect(await browserFontsAvailable()).toBe(false);
  expect(await browserFontsAvailable()).toBe(true);
});
it('keeps private native output out of viewer diagnostics and preserves legacy message bounds', () => {
  const error = browserStartError(
    new Error(
      'error while loading shared libraries: secret-proxy-and-task-url',
    ),
  );
  expect(error).toBeInstanceOf(RuntimeBrowserStartError);
  expect(error.message).not.toContain('secret-proxy');
  expect(error.message.length).toBeLessThanOrEqual(400);
  expect(error.setupCommand).toContain('--data-root');
  expect(
    browserStartError(new Error('Running as root without --no-sandbox')).reason,
  ).toBe('root');
  expect(
    browserStartError(new Error('Chromium sandboxing failed!')).reason,
  ).toBe('sandbox');
});

const linux = process.platform === 'linux' ? describe : describe.skip;
linux('Linux sandbox diagnosis', () => {
  it('distinguishes root, AppArmor and other namespace restrictions after a launch failure', async () => {
    const userId = jest.spyOn(process, 'getuid');
    const restricted = jest.spyOn(diagnostics, 'appArmorRestricted');
    const signal = new AbortController().signal;
    try {
      userId.mockReturnValue(0);
      expect(
        (
          await diagnoseBrowserStartFailure(
            new Error('Chromium sandboxing failed!'),
            '/browser',
            signal,
          )
        ).reason,
      ).toBe('root');
      expect(restricted).not.toHaveBeenCalled();
      userId.mockReturnValue(1000);
      restricted.mockResolvedValue(true);
      expect(
        (
          await diagnoseBrowserStartFailure(
            new Error('No usable sandbox'),
            '/browser',
            signal,
          )
        ).reason,
      ).toBe('apparmor');
      restricted.mockResolvedValue(false);
      expect(
        (
          await diagnoseBrowserStartFailure(
            new Error('No usable sandbox'),
            '/browser',
            signal,
          )
        ).reason,
      ).toBe('sandbox');
    } finally {
      userId.mockRestore();
      restricted.mockRestore();
    }
  });
});
