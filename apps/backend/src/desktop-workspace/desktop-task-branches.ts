import {
  WORKSPACE_BRANCH_NAME_LIMIT,
  type WorkspaceBranch,
} from '@elevenex/shared';
import type { BranchInfo } from '../branches/branches.service.js';
import { taskRemoteRef } from '../tasks/task-git.service.js';

export type TaskBranchChoice = Omit<
  WorkspaceBranch,
  'defaultBase' | 'heldTaskName'
>;

export function taskBranchWindow(
  branches: readonly BranchInfo[],
  remotes: readonly string[],
  defaultBase: string | null,
  query: string,
  limit: number,
): {
  readonly choices: readonly TaskBranchChoice[];
  readonly defaultBase: string | null;
} {
  const choices = branches
    .filter((branch) => branch.name.length <= WORKSPACE_BRANCH_NAME_LIMIT)
    .map((branch) => {
      const ref =
        (branch.isRemote ? 'refs/remotes/' : 'refs/heads/') + branch.name;
      const remote = branch.isRemote ? taskRemoteRef(ref, remotes) : null;
      return {
        name: branch.name,
        current: branch.current,
        ref,
        remoteBranch: remote?.branch,
        isDefault: false,
      };
    });
  const preferred =
    choices.find((choice) => choice.ref === defaultBase) ??
    choices.find((choice) => choice.name === defaultBase);
  if (preferred) preferred.isDefault = true;
  const defaultRef = preferred?.ref ?? defaultBase;

  const search = query.trim().toLowerCase();
  if (search) {
    const words = search.split(/[\s/_-]+/).filter(Boolean);
    const fullRef = /^refs\/(heads|remotes)\//.test(search);
    const matching = choices
      .map((choice) => {
        const name = choice.name.toLowerCase();
        const ref = choice.ref.toLowerCase();
        const short = choice.remoteBranch?.toLowerCase();
        const exact = fullRef ? ref === search : name === search;
        const prefix = fullRef
          ? ref.startsWith(search)
          : name.startsWith(search) || short?.startsWith(search);
        const matches = fullRef
          ? prefix
          : words.every((word) => name.includes(word));
        const rank = exact
          ? 0
          : short === search
            ? 1
            : choice.isDefault
              ? 2
              : prefix
                ? 3
                : 4;
        return { choice, matches, rank };
      })
      .filter((match) => match.matches)
      .sort(
        (a, b) =>
          a.rank - b.rank || a.choice.name.length - b.choice.name.length,
      )
      .slice(0, limit)
      .map((match) => match.choice);
    return { choices: matching, defaultBase: defaultRef };
  }

  // The first visible window should contain both kinds even if there are
  // hundreds of local refs. The default and current branches lead the window.
  const local = choices.filter(
    (choice) => choice !== preferred && choice.ref.startsWith('refs/heads/'),
  );
  const remote = choices.filter(
    (choice) => choice !== preferred && choice.ref.startsWith('refs/remotes/'),
  );
  local.sort((a, b) => Number(b.current) - Number(a.current));
  const result = preferred ? [preferred] : [];
  for (
    let index = 0;
    result.length < limit && index < Math.max(local.length, remote.length);
    index++
  ) {
    if (local[index]) result.push(local[index]);
    if (remote[index] && result.length < limit) result.push(remote[index]);
  }
  return { choices: result, defaultBase: defaultRef };
}
