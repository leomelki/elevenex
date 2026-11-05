import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { desktopShellIntegration } from './desktop-shell-integration.js';
import { DesktopTerminalStream } from './desktop-terminal-stream.js';
import { terminatePtyAndWait } from '../terminal/pty-termination.js';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shells = ['/bin/bash', '/opt/homebrew/bin/bash', '/bin/zsh'].filter(
  existsSync,
);
const disposers: (() => Promise<void>)[] = [];
const waitFor = async (predicate: () => boolean) => {
  const until = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Shell condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function open(shell: string, settings = '') {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-shell-command-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const rc = `${settings}\nPS1='SHELL_READY> '\nprintf 'RC_ONCE\\n'\n`;
  await writeFile(join(root, shell.endsWith('zsh') ? '.zshrc' : '.bashrc'), rc);
  const integration = await desktopShellIntegration(
    shell,
    {
      ...process.env,
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: join(root, 'history'),
      HISTCONTROL: '',
      ELEVENEX_USER_CWD: cwd,
    },
    token,
  );
  const terminal = pty.spawn(shell, integration.args, {
    cwd,
    env: integration.env,
  });
  const stream = new DesktopTerminalStream(null, token);
  let output = '';
  let exited = false;
  const data = terminal.onData((chunk) => {
    output += chunk;
    stream.append(chunk);
  });
  const exit = terminal.onExit(({ exitCode }) => {
    exited = true;
    stream.exited(exitCode);
  });
  disposers.push(async () => {
    try {
      if (!exited) await terminatePtyAndWait(terminal);
    } finally {
      data.dispose();
      exit.dispose();
      await integration.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
  await waitFor(
    () => stream.integration === 'active' && output.includes('SHELL_READY> '),
  );
  return {
    terminal,
    stream,
    root,
    cwd,
    output: () => output,
    send: async (command: string) => {
      const before = output.length;
      stream.input(command);
      terminal.write(command);
      await waitFor(() =>
        output.slice(before).includes(`\x1b]133;B;${token}\x07`),
      );
    },
  };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

it.each(shells)(
  'reports actual submitted commands after history editing in %s',
  async (shell) => {
    const session = await open(shell);
    const command = "printf '%s\\n' '🙂;\\value'; false";
    await session.send(command + '\r');
    expect(session.stream.command).toBe(command);
    expect(session.stream.rerunInput()).toBe(command + '\r');
    await session.send('\x1b[A\r');
    expect(session.stream.command).toBe(command);
    expect(session.stream.rerunInput()).toBe(command + '\r');
    expect(session.output().match(/RC_ONCE\r?\n/g)).toHaveLength(1);
  },
);

it.each(shells)(
  'keeps password/program input out of command metadata in %s',
  async (shell) => {
    const session = await open(shell);
    const command = "read -r secret; printf 'FINISHED\\n'; false";
    session.stream.input(command + '\r');
    session.terminal.write(command + '\r');
    await waitFor(() => session.stream.status === 'running');
    await session.send('PRIVATE_PASSWORD\r');
    expect(session.stream.command).toBe(command);
    expect(session.stream.rerunInput()).toBeNull();
  },
);

it.each(shells.filter((shell) => shell.endsWith('bash')))(
  'does not rerun stale Bash history when commands are ignored in %s',
  async (shell) => {
    const session = await open(
      shell,
      "HISTCONTROL=ignoreboth\nHISTIGNORE='printf*'",
    );
    await session.send('false\r');
    expect(session.stream.rerunInput()).toBe('false\r');
    for (const command of [' false', 'false', "printf 'ignored\\n'; false"]) {
      await session.send(command + '\r');
      expect(session.stream.status).toBe('failed');
      expect(session.stream.command).toBe('Shell command');
      expect(session.stream.canRerun).toBe(false);
    }
  },
);

it.each(shells.filter((shell) => shell.endsWith('bash')))(
  'preserves BASH_REMATCH across prompt hooks in %s',
  async (shell) => {
    const session = await open(shell);
    await session.send('[[ alpha =~ (alpha) ]]; false\r');
    await session.send('printf "MATCH_%s\\n" "${BASH_REMATCH[1]}"\r');
    expect(session.output()).toContain('MATCH_alpha');
  },
);

it.each(shells.filter((shell) => shell.endsWith('bash')))(
  'keeps an existing DEBUG trap in %s',
  async (shell) => {
    const session = await open(shell, "trap ':' DEBUG");
    await session.send('printf \'DEBUG_%s\\n\' "$(trap -p DEBUG)"\r');
    expect(session.output()).toContain("DEBUG_trap -- ':' DEBUG");
  },
);

it.each(shells)(
  'preserves an explicit history file and saves commands on exit in %s',
  async (shell) => {
    const settings =
      'HISTFILE="$HOME/kept-history"\nHISTSIZE=100\nSAVEHIST=100';
    const session = await open(shell, settings);
    await session.send('false\r');
    session.terminal.write('exit\r');
    await waitFor(
      () =>
        session.stream.status === 'exited' ||
        (session.stream.status === 'failed' && !session.stream.canRerun),
    );
    await waitFor(() => existsSync(join(session.root, 'kept-history')));
    expect(
      await readFile(join(session.root, 'kept-history'), 'utf8'),
    ).toContain('false');
  },
);
