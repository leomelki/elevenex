import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Status hooks only. Never source files from a repository or replace the user's profile. */
export async function desktopShellIntegration(
  shell: string,
  env: NodeJS.ProcessEnv,
) {
  const name = path.basename(shell).replace(/\.exe$/i, '');
  if (name !== 'bash' && name !== 'zsh')
    return { args: [] as string[], env, cleanup: async () => {} };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elevenex-user-shell-'));
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  try {
    if (name === 'zsh') {
      await fs.writeFile(
        path.join(root, '.zshrc'),
        `
if [[ -n "$ELEVENEX_USER_ZDOTDIR" ]]; then ZDOTDIR="$ELEVENEX_USER_ZDOTDIR"; else unset ZDOTDIR; fi
[[ -r "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc"
builtin cd -- "$ELEVENEX_USER_CWD" || exit 1
function _elevenex_user_preexec() { printf '\\033]133;C\\007'; }
function _elevenex_user_precmd() { local result=$?; printf '\\033]133;D;%s\\007' "$result"; }
autoload -Uz add-zsh-hook
add-zsh-hook preexec _elevenex_user_preexec
add-zsh-hook precmd _elevenex_user_precmd
`,
      );
      return {
        args: ['-i'],
        env: {
          ...env,
          ELEVENEX_USER_ZDOTDIR: env.ZDOTDIR ?? '',
          ZDOTDIR: root,
        },
        cleanup,
      };
    }
    const rc = path.join(root, 'bashrc');
    await fs.writeFile(
      rc,
      `
[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
builtin cd -- "$ELEVENEX_USER_CWD" || exit 1
_elevenex_user_prompt() { local result=$?; printf '\\033]133;D;%s\\007' "$result"; }
PROMPT_COMMAND="_elevenex_user_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
PS0=$'\\033]133;C\\007'
`,
    );
    return { args: ['--rcfile', rc, '-i'], env, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
