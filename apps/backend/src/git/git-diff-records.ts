import { copyCacheString } from './git-cache.js';

/** Git emits all raw records first, followed by numstat records, with -z. */
export interface GitDiffRecord {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export function renameDetectionMayBeLimited(
  records: readonly Pick<GitDiffRecord, 'status'>[],
  limit = 200,
): boolean {
  let sources = 0,
    destinations = 0;
  for (const record of records) {
    if (record.status === 'deleted') sources++;
    if (record.status === 'added') destinations++;
  }
  return sources * destinations > limit * limit;
}

export function parseGitDiffRecords(output: string): GitDiffRecord[] {
  const tokens = output.split('\0');
  const records: GitDiffRecord[] = [];
  const byPath = new Map<string, GitDiffRecord>();
  let index = 0;
  while (tokens[index]?.startsWith(':')) {
    const header =
      /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(
        tokens[index++],
      );
    if (!header || index >= tokens.length)
      throw new Error('Invalid Git raw diff framing');
    const first = tokens[index++];
    const rename = header[5] === 'R' || header[5] === 'C';
    const next = rename ? tokens[index++] : first;
    if (!first || !next) throw new Error('Missing Git raw diff path');
    const record: GitDiffRecord = {
      path: copyCacheString(next),
      oldPath: rename ? copyCacheString(first) : null,
      oldMode: copyCacheString(header[1]),
      newMode: copyCacheString(header[2]),
      oldOid: copyCacheString(header[3]),
      newOid: copyCacheString(header[4]),
      status: rename
        ? 'renamed'
        : header[5] === 'A'
          ? 'added'
          : header[5] === 'D'
            ? 'deleted'
            : 'modified',
      additions: 0,
      deletions: 0,
      binary: false,
    };
    records.push(record);
    byPath.set(next, record);
  }
  while (index < tokens.length && tokens[index] !== '') {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index++]);
    if (!match) throw new Error('Invalid Git numstat framing');
    let filePath = match[3];
    if (filePath === '') {
      const oldPath = tokens[index++];
      filePath = tokens[index++];
      if (!oldPath || !filePath)
        throw new Error('Missing Git numstat rename path');
    }
    const record = byPath.get(filePath);
    if (!record) throw new Error('Git numstat path has no raw record');
    record.binary = match[1] === '-' || match[2] === '-';
    record.additions = record.binary ? 0 : Number(match[1]);
    record.deletions = record.binary ? 0 : Number(match[2]);
  }
  return records;
}
