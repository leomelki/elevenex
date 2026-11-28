import type { SubTask } from "../task.models";

export interface SubtaskLocation {
  readonly subtask: SubTask;
  readonly parents: readonly SubTask[];
}

/** Flatten arbitrary branch depth into one visual indent, in supplied sibling order.
 * Missing, merged and cyclic parents are tolerated at this supplied-data boundary. */
export function subtaskLocations(
  subtasks: readonly SubTask[],
): readonly SubtaskLocation[] {
  const open = subtasks.filter((subtask) => !subtask.merged);
  const byId = new Map(open.map((subtask) => [subtask.id, subtask]));
  const byParent = new Map<string | null, SubTask[]>();
  for (const subtask of open) {
    const parent =
      subtask.parent && byId.has(subtask.parent) ? subtask.parent : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(subtask);
    byParent.set(parent, siblings);
  }
  const result: SubtaskLocation[] = [];
  const seen = new Set<string>();
  const append = (root: SubTask, parents: readonly SubTask[]): void => {
    // An explicit stack keeps supplied branch depth from overflowing the JS stack.
    const stack: SubtaskLocation[] = [{ subtask: root, parents }];
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current.subtask.id)) continue;
      seen.add(current.subtask.id);
      result.push(current);
      const children = byParent.get(current.subtask.id) ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child)
          stack.push({
            subtask: child,
            parents: [...current.parents, current.subtask],
          });
      }
    }
  };
  for (const root of byParent.get(null) ?? []) append(root, []);
  for (const orphan of open) if (!seen.has(orphan.id)) append(orphan, []);
  return result;
}
