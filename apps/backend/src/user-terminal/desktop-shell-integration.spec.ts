import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { desktopShellIntegration } from './desktop-shell-integration.js';
import { terminatePtyAndWait } from '../terminal/pty-termination.js';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

it.each([
  {
    shell: '/bin/bash',
    rc: `PROMPT_COMMAND='printf "USER_STATUS=%s\\n" "$?" # existing comment'`,
    tail: 'USER_STATUS=1',
  },
  ...(existsSync('/opt/homebrew/bin/bash')
    ? [
        {
          shell: '/opt/homebrew/bin/bash',
          rc: `PROMPT_COMMAND=('printf "USER_STATUS=%s\\n" "$?"' 'printf "SECOND_HOOK\\n"')`,
          tail: 'SECOND_HOOK',
        },
      ]
    : []),
])(
  'preserves prompt hooks and status in $shell',
  async ({ shell, rc, tail }) => {
    const root = await mkdtemp(join(tmpdir(), 'elevenex-prompt-test-'));
    const integration = await desktopShellIntegration(
      shell,
      {
        ...process.env,
        HOME: root,
        ELEVENEX_USER_CWD: root,
      },
      token,
    );
    let terminal: pty.IPty | undefined;
    try {
      await writeFile(
        join(root, '.bashrc'),
        `export PS0='ORIGINAL_PS0'\nset -a\n${rc}\nPS1='READY> '\n`,
      );
      terminal = pty.spawn(shell, integration.args, {
        cwd: root,
        env: integration.env,
      });
      let output = '';
      const changed = terminal.onData((data) => {
        output += data;
      });
      const waitFor = async (needle: string) => {
        const deadline = Date.now() + 5000;
        while (!output.includes(needle)) {
          if (Date.now() > deadline)
            throw new Error(`Missing ${needle}: ${output}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      try {
        await waitFor('READY> ');
        output = '';
        terminal.write('false\r');
        await waitFor('READY> ');
        expect(output).toContain('USER_STATUS=1');
        expect(output.indexOf(`\x1b]133;D;${token};1\x07`)).toBeLessThan(
          output.indexOf('USER_STATUS=1'),
        );
        expect(output.indexOf(`\x1b]133;B;${token}\x07`)).toBeGreaterThan(
          output.indexOf(tail),
        );
        output = '';
        terminal.write(
          "env | grep -E '^(PS0=|BASH_FUNC__elevenex_)'; printf '\\nENV_DONE\\n'\r",
        );
        await waitFor('READY> ');
        expect(output).not.toMatch(/^PS0=/m);
        expect(output).not.toMatch(/^BASH_FUNC__elevenex_/m);
      } finally {
        changed.dispose();
      }
    } finally {
      if (terminal) await terminatePtyAndWait(terminal);
      await integration.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  },
);
