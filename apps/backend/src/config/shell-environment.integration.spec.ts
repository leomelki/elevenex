import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildAugmentedEnvAsync,
  clearBinaryPathCache,
  findBinary,
} from './system-paths.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('real login-shell environment', () => {
  it('discovers a CLI from HOME with a stripped PATH and retains multiline and worktree exports', async () => {
    const directory = await mkdtemp(join(os.tmpdir(), 'elevenex shell env '));
    const home = join(directory, 'home');
    const workspace = join(directory, 'workspace');
    const originalEnv = { ...process.env };
    const homeLookup = jest
      .spyOn(jest.requireActual<typeof os>('os'), 'homedir')
      .mockReturnValue(home);
    try {
      await mkdir(join(home, 'bin'), { recursive: true });
      await mkdir(workspace);
      await writeFile(
        join(home, '.bash_profile'),
        [
          "printf 'startup banner\\n'",
          'export PATH="$HOME/bin:$PATH"',
          'export ELEVENEX_CAPTURE_CWD="$PWD"',
          "export ELEVENEX_MULTILINE='first\nPATH=/wrong/bin\nlast=世界'",
          'export ELEVENEX_CAPTURE_VALUE=global ELEVENEX_REMOVED=global',
          'if [ -f .elevenex-env ]; then . ./.elevenex-env; fi',
        ].join('\n'),
      );
      await writeFile(
        join(home, '.bash_logout'),
        "printf 'logout banner\\n'\n",
      );
      await writeFile(
        join(workspace, '.elevenex-env'),
        'export ELEVENEX_CAPTURE_VALUE=project\nunset ELEVENEX_REMOVED\n',
      );
      const binary = join(home, 'bin', 'elevenex-fixture-cli');
      await writeFile(binary, '#!/bin/sh\nprintf fixture-ok\n', {
        mode: 0o755,
      });
      process.env.HOME = home;
      process.env.SHELL = '/bin/bash';
      process.env.PATH = '/usr/bin:/bin';
      clearBinaryPathCache();

      const global = await buildAugmentedEnvAsync();
      expect(global.ELEVENEX_CAPTURE_CWD).toBe(home);
      expect(global.ELEVENEX_MULTILINE).toBe(
        'first\nPATH=/wrong/bin\nlast=世界',
      );
      expect(global.PATH).not.toContain('/wrong/bin');
      expect(findBinary('elevenex-fixture-cli')).toBe(binary);
      const result = await promisify(execFile)(binary, [], {
        env: global,
        timeout: 5000,
      });
      expect(result.stdout).toBe('fixture-ok');

      const project = await buildAugmentedEnvAsync(process.env, workspace);
      expect(project.ELEVENEX_CAPTURE_CWD).toBe(workspace);
      expect(project.ELEVENEX_CAPTURE_VALUE).toBe('project');
      expect(project.ELEVENEX_REMOVED).toBeUndefined();
      expect(process.env.ELEVENEX_CAPTURE_VALUE).toBe('global');
    } finally {
      homeLookup.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
      clearBinaryPathCache();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
