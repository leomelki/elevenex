/** Pi saves a tree in append order. Copy the selected entry's actual ancestry
 * so abandoned branches do not become the active context of the new file. */
export function piSessionBranch(entries: readonly Record<string, unknown>[], leaf: number): readonly number[] {
  if (leaf < 0) return [];
  if (!Object.hasOwn(entries[leaf], 'parentId'))
    return Array.from({ length: leaf + 1 }, (_, index) => index);
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const branch: number[] = [];
  while (leaf >= 0) {
    branch.push(leaf);
    const parent = entries[leaf].parentId;
    if (parent === null) break;
    const previous = typeof parent === 'string' ? positions.get(parent) : undefined;
    if (previous === undefined || previous >= leaf)
      throw new Error('Pi session has an invalid entry ancestry.');
    leaf = previous;
  }
  return branch.reverse();
}

export function piSessionBefore(entries: readonly Record<string, unknown>[], anchor: number): Record<string, unknown>[] {
  const entry = entries[anchor];
  if (!Object.hasOwn(entry, 'parentId')) return entries.slice(0, anchor);
  const index = entries.findIndex(candidate => candidate.id === entry.parentId && candidate.type !== 'session');
  if (entry.parentId !== null && (index < 0 || index >= anchor))
    throw new Error('Pi session has an invalid edit boundary.');
  const retained = piSessionBranch(entries, index).map(position => entries[position]);
  return entries[0]?.type === 'session' ? [entries[0], ...retained] : retained;
}
