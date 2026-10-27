import type { SimpleGit } from 'simple-git';

/**
 * Upper bound for the combined size of pathspec arguments passed on a git
 * command line. Windows caps a whole command line at 32,767 characters and
 * Linux caps a single argument at 128 KiB, so 24 KiB leaves headroom on every
 * platform. Callers fall back to an unrestricted command above this budget: a
 * change set that large gains little from path limiting anyway.
 */
export const MAX_PATHSPEC_BYTES = 24 * 1024;

/**
 * Builds `-- :(top,literal)<path>...` arguments that restrict a git command to
 * exactly the given repository-root-relative paths.
 *
 * `top` anchors each path at the repository root, so the arguments stay
 * correct when the command runs from a subdirectory; porcelain status output,
 * for example, is always root-relative. `literal` disables glob matching, so
 * file names containing `*`, `?`, `[` or `:` match only themselves.
 *
 * Returns `null` when the paths do not fit in {@link MAX_PATHSPEC_BYTES}; the
 * caller should then run the command without a pathspec. An empty input also
 * returns `null`, because an empty pathspec means "everything" to git.
 */
export function literalPathspecArgs(paths: Iterable<string>): string[] | null {
  return boundedPathspecArgs(paths, ':(top,literal)');
}

/**
 * {@link literalPathspecArgs} for commands that already run with
 * `--literal-pathspecs`, such as `scheduledGitRaw`. Pathspec magic is disabled
 * there, so the paths are passed verbatim and must be relative to the
 * command's working directory, which must be the repository root.
 */
export function verbatimPathspecArgs(paths: Iterable<string>): string[] | null {
  return boundedPathspecArgs(paths, '');
}

function boundedPathspecArgs(
  paths: Iterable<string>,
  prefix: string,
): string[] | null {
  const args = ['--'];
  let bytes = 0;
  for (const filePath of new Set(paths)) {
    if (!filePath) continue;
    const arg = `${prefix}${filePath}`;
    bytes += Buffer.byteLength(arg) + 1;
    if (bytes > MAX_PATHSPEC_BYTES) return null;
    args.push(arg);
  }
  return args.length > 1 ? args : null;
}

/**
 * Splits paths into `-- :(top,literal)...` argument lists that each fit within
 * {@link MAX_PATHSPEC_BYTES}, for commands that must cover every path, such as
 * listing the contents of many untracked directories.
 */
export function chunkedLiteralPathspecArgs(
  paths: Iterable<string>,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const filePath of new Set(paths)) {
    if (!filePath) continue;
    const arg = `:(top,literal)${filePath}`;
    const size = Buffer.byteLength(arg) + 1;
    if (current.length > 0 && bytes + size > MAX_PATHSPEC_BYTES) {
      chunks.push(['--', ...current]);
      current = [];
      bytes = 0;
    }
    current.push(arg);
    bytes += size;
  }
  if (current.length > 0) chunks.push(['--', ...current]);
  return chunks;
}

/**
 * Global pathspec switches a user may export in their shell. Any of them would
 * change how the magic in {@link literalPathspecArgs} is parsed (for example,
 * `GIT_LITERAL_PATHSPECS=1` makes `:(top,literal)` part of the file name).
 */
const PATHSPEC_ENV_SWITCHES = [
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
] as const;

/**
 * Neutralizes the user's global pathspec switches on a simple-git instance
 * (git treats `0` exactly like unset). Use it on any instance that receives
 * {@link literalPathspecArgs}. The instance must already have an explicit env,
 * as instances from `worktreeSimpleGit` do, so the other variables are kept.
 */
export function withDefaultPathspecParsing(git: SimpleGit): SimpleGit {
  for (const name of PATHSPEC_ENV_SWITCHES) git.env(name, '0');
  return git;
}
