import { git, nulStrings } from './worktree-content-diff.js';

const REFLOG_LIMIT = 1024;
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface RebaseBaseline {
  head: string;
  earlierPaths: Set<string>;
}

export async function changedTreePaths(
  root: string,
  before: string,
  after: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (before === after) return [];
  return nulStrings(
    await git(
      root,
      [
        'diff',
        '--name-only',
        '--no-renames',
        '--no-ext-diff',
        '-z',
        before,
        after,
        '--',
      ],
      undefined,
      [0],
      signal,
    ),
  );
}

/**
 * A rebase replaces the checkout with an upstream tree and replays existing
 * commits. Use its result as the baseline for paths without earlier edits.
 * HEAD's reflog belongs to this worktree and also records fast-forward rebases.
 */
export async function findRebaseBaseline(
  root: string,
  before: string | null,
  after: string | null,
  signal: AbortSignal,
): Promise<RebaseBaseline | undefined> {
  if (!before || !after || before === after) return;
  try {
    const fields = (
      await git(
        root,
        [
          'reflog',
          'show',
          '-n',
          String(REFLOG_LIMIT),
          '-z',
          '--format=%H%x00%gs',
          'HEAD',
        ],
        undefined,
        [0],
        signal,
      )
    )
      .toString('utf8')
      .split('\0');
    if (fields[0] !== after) return; // HEAD moved past the captured endpoint.
    let rebasedHead: string | undefined;
    let previousHead: string | undefined;
    for (let i = 0; i + 2 < fields.length; i += 2) {
      const [head, action] = [fields[i], fields[i + 1]];
      if (!COMMIT_ID.test(head)) return;
      if (head === before) {
        if (!rebasedHead || !previousHead) return;
        return {
          head: rebasedHead,
          earlierPaths: new Set(
            await changedTreePaths(root, before, previousHead, signal),
          ),
        };
      }
      if (previousHead) continue;
      if (action.startsWith('rebase (finish):')) rebasedHead = head;
      // A stopped rebase keeps conflicts and staged resolutions in status.
      else if (
        i === 0 &&
        /^rebase \((start|pick|continue|edit)\):/.test(action)
      )
        rebasedHead = after;
      if (rebasedHead && action.startsWith('rebase (start):'))
        previousHead = fields[i + 2];
    }
  } catch {
    // Disabled/expired reflogs and unavailable objects retain the normal diff.
  }
}
