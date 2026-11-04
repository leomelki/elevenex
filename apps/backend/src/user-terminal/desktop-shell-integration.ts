import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Status hooks only. Never source files from a repository or replace the user's profile. */
export async function desktopShellIntegration(
  shell: string,
  env: NodeJS.ProcessEnv,
  promptToken: string,
) {
  if (!/^[a-f\d-]{36}$/.test(promptToken))
    throw new Error('Invalid shell hook token');
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
function _elevenex_user_preexec() { printf '\\033]133;C;${promptToken}\\007'; }
# A nonzero zsh hook return would skip later hooks, including periodic.
function _elevenex_user_precmd() { local result=$?; printf '\\033]133;D;${promptToken};%s\\007\\033]133;B;${promptToken}\\007' "$result"; }
autoload -Uz add-zsh-hook
add-zsh-hook preexec _elevenex_user_preexec
add-zsh-hook precmd _elevenex_user_precmd
`,
        { mode: 0o600 },
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
_elevenex_user_status() { local result=$?; printf '\\033]133;D;${promptToken};%s\\007' "$result"; return "$result"; }
_elevenex_user_ready() { local result=$?; printf '\\033]133;B;${promptToken}\\007'; return "$result"; }
# Preserve array hooks (Bash 5.1+) and the original status seen by the first hook.
# Readiness comes last: user prompt hooks can themselves ask for secret input.
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) &&
   [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND=(_elevenex_user_status "\${PROMPT_COMMAND[@]}" _elevenex_user_ready)
else
  PROMPT_COMMAND="_elevenex_user_status; \${PROMPT_COMMAND:-:}
_elevenex_user_ready"
fi
PS0=$'\\033]133;C;${promptToken}\\007'"\${PS0-}"
# Profiles may enable allexport or export PS0. Keep the hook token out of children.
export -n PS0
export -n -f _elevenex_user_status _elevenex_user_ready
`,
      { mode: 0o600 },
    );
    return { args: ['--rcfile', rc, '-i'], env, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
