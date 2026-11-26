import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAndroidApp } from './android-app.js';

describe('Android virtual device launch', () => {
  const native = process.platform === 'win32' ? it.skip : it;
  native('selects the installed SDK emulator and gives two runs separate disposable data', async () => {
    const sdk = await mkdtemp(join(tmpdir(), 'elevenex-android-sdk-'));
    try {
      const emulator = join(sdk, 'emulator', 'emulator');
      await mkdir(join(sdk, 'emulator'));
      await writeFile(emulator, '#!/bin/sh\ncase "$1" in\n-list-avds) echo Pixel_8;;\n-accel-check) printf "accel:\\n0\\nusable\\n" ;;\n*) exit 1;;\nesac\n', { mode: 0o700 });
      const env = { ANDROID_HOME: sdk };
      const first = join(sdk, 'first'), second = join(sdk, 'second');
      await Promise.all([mkdir(first), mkdir(second)]);
      const runs = await Promise.all([prepareAndroidApp('Pixel_8', first, env), prepareAndroidApp('Pixel_8', second, env)]);
      expect(runs.map(run => run.executable)).toEqual([emulator, emulator]);
      for (const [index, run] of runs.entries()) {
        const data = run.args[run.args.indexOf('-datadir') + 1];
        expect(data).toBe(join([first,second][index], 'avd-data'));
        expect((await stat(data)).isDirectory()).toBe(true);
        expect(run.args).toEqual(expect.arrayContaining(['-no-snapshot', '-read-only', '-avd', 'Pixel_8']));
      }
      await expect(prepareAndroidApp('missing', first, env)).rejects.toThrow('unavailable');
      await expect(prepareAndroidApp('../escape', first, env)).rejects.toThrow('Invalid');
    } finally { await rm(sdk, { recursive: true, force: true }); }
  });
});
