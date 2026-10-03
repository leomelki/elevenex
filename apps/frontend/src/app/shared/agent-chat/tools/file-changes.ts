import { diffLines } from 'diff';

export interface FileChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
  label: string;
  patch: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  emptyText: string;
}

/** Provider-normalized file changes, shared by tool cards and turn statistics. */
export function parseFileChanges(input: unknown): FileChange[] {
  const record = asRecord(input);
  const changes = Array.isArray(record?.['changes']) ? record['changes'] : [];
  return changes.flatMap((entry): FileChange[] => {
    const change = asRecord(entry);
    if (!change) return [];
    const path = firstString(change, 'path', 'file_path', 'filePath');
    if (!path) return [];
    const kindData = asRecord(change['kind']);
    const rawKind = String(kindData?.['type'] ?? change['kind'] ?? '').toLowerCase();
    const kind = ['add', 'create', 'created'].includes(rawKind)
      ? 'add'
      : ['delete', 'deleted', 'remove'].includes(rawKind)
        ? 'delete'
        : 'update';
    const movePath = firstString(kindData ?? {}, 'move_path', 'movePath');
    const rawDiff = firstString(change, 'diff', 'patch', 'unifiedDiff');
    const unifiedPatch = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(rawDiff);
    const patch = kind === 'update' || unifiedPatch ? rawDiff : '';
    const oldString =
      firstString(change, 'old_string', 'oldString', 'before', 'oldText', 'previousContent') ||
      (kind === 'delete' && !unifiedPatch ? rawDiff : '');
    const newString =
      firstString(change, 'new_string', 'newString', 'after', 'newText', 'content') ||
      (kind === 'add' && !unifiedPatch ? rawDiff : '');
    let additions = 0;
    let deletions = 0;
    if (patch) {
      let inHunk = false;
      for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) {
          inHunk = true;
          continue;
        }
        if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))) continue;
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }
    } else if (kind === 'add') additions = countLines(newString);
    else if (kind === 'delete') deletions = countLines(oldString);
    else {
      for (const chunk of diffLines(oldString, newString)) {
        if (chunk.added) additions += chunk.count ?? 0;
        else if (chunk.removed) deletions += chunk.count ?? 0;
      }
    }
    return [
      {
        path,
        kind,
        patch,
        oldString,
        newString,
        additions: finiteCount(change['additions']) ?? additions,
        deletions: finiteCount(change['deletions']) ?? deletions,
        label: movePath
          ? `${path} → ${movePath}`
          : kind === 'add'
            ? `${path} · Created`
            : kind === 'delete'
              ? `${path} · Deleted`
              : path,
        emptyText: `File ${kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'updated'}; inline diff was not captured.`,
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys)
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  return '';
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
