import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { desktopShellIntegration } from './desktop-shell-integration.js';
import { terminatePtyAndWait } from '../terminal/pty-termination.js';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

it('starts ordinary shells without preparing files when disabled or unsupported', async () => {
  const prepare = jest.spyOn(fs, 'mkdtemp');
  const env = { ...process.env };
  try {
    const disabled = await desktopShellIntegration(
      '/bin/zsh',
      env,
      token,
      false,
    );
    expect(disabled).toMatchObject({ args: [], env, integration: 'disabled' });
    expect(disabled.env).toBe(env);
    expect(
      (await desktopShellIntegration('/bin/fish', env, token)).integration,
    ).toBe('unsupported');
    expect(
      (
        await desktopShellIntegration(
          '/bin/bash',
          { ...env, ELEVENEX_TERMINAL_SHELL_INTEGRATION: '0' },
          token,
        )
      ).integration,
    ).toBe('disabled');
    expect(prepare).not.toHaveBeenCalled();
    await disabled.cleanup();
  } finally {
    prepare.mockRestore();
  }
});

it('falls back to an ordinary shell and removes partial integration files when preparation fails', async () => {
  const prepare = fs.mkdtemp.bind(fs);
  let directory = '';
  const created = jest
    .spyOn(fs, 'mkdtemp')
    .mockImplementation(async (...args) => {
      directory = String(await prepare(...args));
      return directory;
    });
  const write = jest
    .spyOn(fs, 'writeFile')
    .mockRejectedValue(new Error('Read-only temporary directory'));
  const env = { ...process.env };
  try {
    const plan = await desktopShellIntegration('/bin/zsh', env, token);
    expect(plan).toMatchObject({ args: [], integration: 'unavailable' });
    expect(plan.env).toBe(env);
    expect(directory).not.toBe('');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    created.mockRestore();
    write.mockRestore();
  }
});

if (existsSync('/bin/zsh'))
  it.each([true, false])(
    'preserves zshenv and its redirected rc directory (rcs enabled: %s)',
    async (enabled) => {
      const root = await mkdtemp(join(tmpdir(), 'elevenex-zshenv-test-'));
      const config = join(root, 'config');
      const integration = await desktopShellIntegration(
        '/bin/zsh',
        {
          ...process.env,
          HOME: root,
          ZDOTDIR: root,
          ELEVENEX_USER_CWD: root,
        },
        token,
      );
      let terminal: pty.IPty | undefined;
      try {
        await mkdir(config);
        await writeFile(
          join(root, '.zshenv'),
          'export USER_ENV=loaded\nZDOTDIR="$HOME/config"\n' +
            (enabled ? '' : 'unsetopt RCS\n'),
        );
        await writeFile(
          join(config, '.zshrc'),
          'PS1="READY> "\nprintf "RC_ENV=%s\\n" "$USER_ENV"\n',
        );
        terminal = pty.spawn('/bin/zsh', integration.args, {
          cwd: root,
          env: integration.env,
        });
        let output = '';
        const changed = terminal.onData((data) => {
          output += data;
        });
        try {
          const until = Date.now() + 5000;
          const ready = enabled ? 'READY> ' : `\x1b]133;X;${token}\x07`;
          while (!output.includes(ready)) {
            if (Date.now() > until)
              throw new Error(`Missing prompt: ${output}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (enabled) {
            expect(output).toContain('RC_ENV=loaded');
            expect(output).toContain(`\x1b]133;B;${token}\x07`);
          } else {
            expect(output).not.toContain('RC_ENV=loaded');
            terminal.write('printf \'CONFIG_%s\\n\' "$ZDOTDIR"\r');
            while (!output.includes('CONFIG_' + config)) {
              if (Date.now() > until)
                throw new Error(`ZDOTDIR not restored: ${output}`);
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
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
          "env | grep -E '^(PS0=|BASH_FUNC__elevenex_|_elevenex_user_)'; printf '\\nENV_DONE\\n'\r",
        );
        await waitFor('READY> ');
        expect(output).not.toMatch(/^PS0=/m);
        expect(output).not.toMatch(/^BASH_FUNC__elevenex_/m);
        expect(output).not.toMatch(/^_elevenex_user_/m);
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
