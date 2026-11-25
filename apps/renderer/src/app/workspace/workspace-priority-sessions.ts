import type { WorkspaceSession, WorkspaceSessionPage } from '@elevenex/shared';

export interface WorkspacePrioritySessions {
  readonly items: readonly WorkspaceSession[];
  readonly parents: readonly WorkspaceSession[];
}

/** Priority is independent of the history cursor. Publish a complete snapshot
 * so a failed continuation never silently hides a previously visible session. */
export async function readPrioritySessions(
  read: (cursor?: string) => Promise<WorkspaceSessionPage | null>,
  current: () => boolean,
): Promise<WorkspacePrioritySessions | null> {
  const items = new Map<number, WorkspaceSession>();
  const parents = new Map<number, WorkspaceSession>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    if (!page || !current()) return null;
    for (const item of page.items) items.set(item.id, item);
    for (const parent of page.parentSessions ?? []) parents.set(parent.id, parent);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { items: [...items.values()], parents: [...parents.values()] };
}

export function mergeNavigationSessions(
  history: readonly WorkspaceSession[],
  priority: WorkspacePrioritySessions | undefined,
  childrenOf: (parentId: number) => readonly WorkspaceSession[],
): readonly WorkspaceSession[] {
  const rows = new Map(history.map(session => [session.id, session]));
  if (priority) {
    const parentIds = new Set(priority.items.map(item => item.parentSessionId));
    for (const parent of priority.parents) {
      if (parentIds.has(parent.id) && !rows.has(parent.id)) rows.set(parent.id, parent);
    }
  }
  const extraChildren = new Map<number, WorkspaceSession>();
  for (const session of priority?.items ?? []) {
    if (session.parentSessionId != null && !rows.has(session.id)) extraChildren.set(session.id, session);
    else rows.set(session.id, session);
  }
  const children = new Map<number, WorkspaceSession>();
  for (const parent of rows.values()) {
    for (const child of childrenOf(parent.id)) {
      children.set(child.id, extraChildren.get(child.id) ?? child);
      extraChildren.delete(child.id);
    }
  }
  // Keep loaded children in their engine-provided nesting order and insert
  // sparse children from outside that window ahead of them.
  return [
    ...[...rows.values()].sort((a, b) => a.id - b.id),
    ...[...extraChildren.values()].sort((a, b) => a.id - b.id),
    ...[...children.values()].filter(child => !rows.has(child.id)),
  ];
}
