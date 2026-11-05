import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { terminatePtyAndWait } from '../terminal/pty-termination.js';
import { desktopShellIntegration } from './desktop-shell-integration.js';
import { DesktopTerminalStream } from './desktop-terminal-stream.js';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const candidates = [
  '/bin/fish',
  '/usr/bin/fish',
  '/usr/local/bin/fish',
  '/opt/homebrew/bin/fish',
  '/usr/bin/pwsh',
  '/usr/local/bin/pwsh',
  '/opt/homebrew/bin/pwsh',
  ...(process.platform === 'win32'
    ? [
        join(
          process.env.ProgramFiles ?? 'C:\\Program Files',
          'PowerShell',
          '7',
          'pwsh.exe',
        ),
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
      ]
    : []),
];
const shells = [...new Set(candidates.filter(existsSync))];

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Adapter condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (!shells.length)
  it.skip('real fish/PowerShell tracking (shells are not installed)', () => {});
else
  it.each(shells)(
    'tracks command escaping, status and directories in %s',
    async (shell) => {
      const root = await mkdtemp(join(tmpdir(), 'elevenex-additional-shell-'));
      const cwd = join(root, 'workspace'),
        directory = join(cwd, 'quoted;folder');
      await mkdir(directory, { recursive: true });
      const plan = await desktopShellIntegration(
        shell,
        {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'config'),
          ELEVENEX_USER_CWD: cwd,
        },
        token,
      );
      let terminal: pty.IPty | undefined;
      let exited = false;
      let data: pty.IDisposable | undefined, exit: pty.IDisposable | undefined;
      try {
        terminal = pty.spawn(shell, plan.args, { cwd, env: plan.env });
        const stream = new DesktopTerminalStream(null, token);
        data = terminal.onData((chunk) => stream.append(chunk));
        exit = terminal.onExit(({ exitCode }) => {
          exited = true;
          stream.exited(exitCode);
        });
        await waitFor(
          () => stream.integration === 'active' && stream.tracking.cwd !== null,
        );
        const powershell = /(?:pwsh|powershell)(?:\.exe)?$/i.test(shell);
        const command = powershell
          ? "Write-Output '🙂;\\value'; Write-Error 'adapter failure' -ErrorAction Continue"
          : "printf '%s\\n' '🙂;\\value'; false";
        stream.input(command + '\r');
        terminal.write(command + '\r');
        await waitFor(
          () => stream.tracking.latest?.command === command && stream.canRerun,
        );
        expect(stream.tracking.latest).toMatchObject({
          command,
          state: 'completed',
          exitCode: 1,
        });
        expect(stream.rerunInput()).toBe(command + '\r');
        const change = `${powershell ? 'Set-Location -LiteralPath' : 'cd'} '${directory.replaceAll("'", powershell ? "''" : "\\'")}'`;
        stream.input(change + '\r');
        terminal.write(change + '\r');
        await waitFor(() => stream.tracking.cwd === directory);
        expect(stream.tracking.latest?.cwd).not.toBe(directory);
      } finally {
        try {
          if (terminal && !exited) await terminatePtyAndWait(terminal);
        } finally {
          data?.dispose();
          exit?.dispose();
          await plan.cleanup();
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    20000,
  );
