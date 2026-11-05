import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ShellIntegrationState =
  | 'pending'
  | 'active'
  | 'disabled'
  | 'unsupported'
  | 'unavailable';
export interface DesktopShellLaunch {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly integration: ShellIntegrationState;
  readonly cleanup: () => Promise<void>;
}

/** Optional launch decoration. Preparation failure never prevents an ordinary shell. */
export async function desktopShellIntegration(
  shell: string,
  env: NodeJS.ProcessEnv,
  promptToken: string,
  enabled = true,
): Promise<DesktopShellLaunch> {
  if (!/^[a-f\d-]{36}$/.test(promptToken))
    throw new Error('Invalid shell hook token');
  const plain = (integration: ShellIntegrationState): DesktopShellLaunch => ({
    args: [],
    env,
    integration,
    cleanup: async () => {},
  });
  if (!enabled || env.ELEVENEX_TERMINAL_SHELL_INTEGRATION === '0')
    return plain('disabled');
  const name = path.basename(shell).replace(/\.exe$/i, '');
  if (name !== 'bash' && name !== 'zsh') return plain('unsupported');
  let root: string | undefined;
  try {
    const files = name === 'zsh' ? ['zshenv', 'zshrc'] : ['bashrc'];
    const sources = await Promise.all(
      files.map((file) =>
        fs.readFile(
          path.join(__dirname, 'shell-integration', 'scripts', file),
          'utf8',
        ),
      ),
    );
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'elevenex-user-shell-'));
    const directory = root;
    await Promise.all(
      files.map((file, index) =>
        fs.writeFile(
          path.join(directory, name === 'zsh' ? `.${file}` : file),
          sources[index].replaceAll('__ELEVENEX_TOKEN__', promptToken),
          { mode: 0o600 },
        ),
      ),
    );
    return {
      args:
        name === 'bash'
          ? ['--rcfile', path.join(root, 'bashrc'), '-i']
          : ['-i'],
      env:
        name === 'zsh'
          ? { ...env, ELEVENEX_USER_ZDOTDIR: env.ZDOTDIR ?? '', ZDOTDIR: root }
          : env,
      integration: 'pending',
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch {
    if (root)
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    return plain('unavailable');
  }
}
