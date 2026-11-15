import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('real login-shell environment', () => {
  it('matches conditional SSH shell startup across forwarding changes with no I/O or probes on warm launches', async () => {
    const directory = await mkdtemp(join(os.tmpdir(), 'elevenex ssh env '));
    const home = join(directory, 'home');
    const proxy = join(directory, 'agent.sock');
    const originalEnv = { ...process.env };
    const homeLookup = jest
      .spyOn(jest.requireActual<typeof os>('os'), 'homedir')
      .mockReturnValue(home);
    let paths: typeof import('./system-paths.js') | undefined;
    const publish = async (value: string) => {
      await writeFile(proxy + '.next', value);
      await rename(proxy + '.next', proxy + '.state');
    };
    try {
      await mkdir(home);
      await publish('0');
      await writeFile(
        join(home, '.bash_profile'),
        [
          'if [ -z "${SSH_AUTH_SOCK:-}" ]; then',
          '  export SSH_AUTH_SOCK="$HOME/server-agent.sock"',
          '  printf started >> "$HOME/agent-starts"',
          'fi',
        ].join('\n'),
      );
      Object.assign(process.env, {
        HOME: home,
        SHELL: '/bin/bash',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: proxy,
        ELEVENEX_SSH_AGENT_PROXY: proxy,
      });
      jest.isolateModules(() => {
        paths =
          jest.requireActual<typeof import('./system-paths.js')>(
            './system-paths.js',
          );
      });
      if (!paths) throw new Error('Shell environment fixture did not load.');
      const environment = paths;
      const waitForAgent = async (expected: string | undefined) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            const env = await environment.buildAugmentedEnvAsync();
            if (env.SSH_AUTH_SOCK === expected) return env;
          } catch {
            /* A transport transition rejects old in-flight captures. */
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('Shell agent did not follow the SSH transport change.');
      };
      const local = join(home, 'server-agent.sock');
      await waitForAgent(local);
      const starts = await readFile(join(home, 'agent-starts'), 'utf8');
      const opens = jest.spyOn(
        jest.requireActual<typeof fileSystem>('node:fs/promises'),
        'open',
      );
      try {
        for (let i = 0; i < 1000; i++)
          expect(
            (await environment.buildAugmentedEnvAsync()).SSH_AUTH_SOCK,
          ).toBe(local);
        expect(opens).not.toHaveBeenCalled();
        expect(await readFile(join(home, 'agent-starts'), 'utf8')).toBe(starts);
      } finally {
        opens.mockRestore();
      }
      await publish('1');
      await waitForAgent(proxy);
      await publish('0');
      await waitForAgent(local);
      await writeFile(join(home, '.bash_profile'), 'unset SSH_AUTH_SOCK\n');
      await environment.refreshLoginShellEnv(true);
      expect(
        (await environment.buildAugmentedEnvAsync()).SSH_AUTH_SOCK,
      ).toBeUndefined();
    } finally {
      paths?.disposeShellEnvironment();
      homeLookup.mockRestore();
      for (const key of Object.keys(process.env))
        if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('discovers a CLI from HOME with a stripped PATH and retains multiline and worktree exports', async () => {
    const directory = await mkdtemp(join(os.tmpdir(), 'elevenex shell env '));
    const home = join(directory, 'home');
    const workspace = join(directory, 'workspace');
    const originalEnv = { ...process.env };
    const homeLookup = jest
      .spyOn(jest.requireActual<typeof os>('os'), 'homedir')
      .mockReturnValue(home);
    let environment: typeof import('./system-paths.js') | undefined;
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
          'export SSH_AUTH_SOCK="$HOME/agent.sock"',
          'if [ -f .elevenex-env ]; then . ./.elevenex-env; fi',
        ].join('\n'),
      );
      await writeFile(
        join(home, '.bash_logout'),
        "printf 'logout banner\\n'\n",
      );
      await writeFile(
        join(workspace, '.elevenex-env'),
        'export ELEVENEX_CAPTURE_VALUE=project\nunset ELEVENEX_REMOVED SSH_AUTH_SOCK\n',
      );
      const binary = join(home, 'bin', 'elevenex-fixture-cli');
      await writeFile(binary, '#!/bin/sh\nprintf fixture-ok\n', {
        mode: 0o755,
      });
      process.env.HOME = home;
      process.env.SHELL = '/bin/bash';
      process.env.PATH = '/usr/bin:/bin';
      process.env.SSH_AUTH_SOCK = '/fixture/transport-agent.sock';
      delete process.env.ELEVENEX_SSH_AGENT_PROXY;
      jest.isolateModules(() => {
        environment =
          jest.requireActual<typeof import('./system-paths.js')>(
            './system-paths.js',
          );
      });
      if (!environment)
        throw new Error('Shell environment fixture did not load.');
      const { buildAugmentedEnvAsync, clearBinaryPathCache, findBinary } =
        environment;
      clearBinaryPathCache();

      const global = await buildAugmentedEnvAsync();
      expect(global.ELEVENEX_CAPTURE_CWD).toBe(home);
      expect(global.SSH_AUTH_SOCK).toBe(join(home, 'agent.sock'));
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
      expect(project.SSH_AUTH_SOCK).toBeUndefined();
      expect(process.env.SSH_AUTH_SOCK).toBe(join(home, 'agent.sock'));
      expect(process.env.ELEVENEX_CAPTURE_VALUE).toBe('global');
    } finally {
      environment?.disposeShellEnvironment();
      homeLookup.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
