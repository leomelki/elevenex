import {
  parseGitDiffRecords,
  renameDetectionMayBeLimited,
} from './git-diff-records.js';

describe('combined raw/numstat framing', () => {
  it('reports limited matching for asymmetric candidate sets and preserves exact renames', () => {
    const candidates = (added: number, deleted: number) => [
      ...Array.from({ length: added }, () => ({ status: 'added' as const })),
      ...Array.from({ length: deleted }, () => ({
        status: 'deleted' as const,
      })),
    ];
    expect(renameDetectionMayBeLimited(candidates(1000, 100))).toBe(true);
    expect(renameDetectionMayBeLimited(candidates(200, 200))).toBe(false);
    expect(
      renameDetectionMayBeLimited(
        Array.from({ length: 1001 }, () => ({ status: 'renamed' as const })),
      ),
    ).toBe(false);
  });
  const old = 'a'.repeat(40),
    next = 'b'.repeat(40),
    zero = '0'.repeat(40);
  it('parses renames, binary, modes, tabs, newlines and colon-prefixed paths', () => {
    const output = [
      `:100644 100755 ${old} ${next} R090`,
      'old\tfile\n.txt',
      'new\tfile\n.txt',
      `:000000 100644 ${zero} ${next} A`,
      ':binary',
      '3\t2\t',
      'old\tfile\n.txt',
      'new\tfile\n.txt',
      '-\t-\t:binary',
      '',
    ].join('\0');
    expect(parseGitDiffRecords(output)).toEqual([
      {
        path: 'new\tfile\n.txt',
        oldPath: 'old\tfile\n.txt',
        status: 'renamed',
        oldMode: '100644',
        newMode: '100755',
        oldOid: old,
        newOid: next,
        additions: 3,
        deletions: 2,
        binary: false,
      },
      {
        path: ':binary',
        oldPath: null,
        status: 'added',
        oldMode: '000000',
        newMode: '100644',
        oldOid: zero,
        newOid: next,
        additions: 0,
        deletions: 0,
        binary: true,
      },
    ]);
  });
  it('rejects incomplete or mismatched framing instead of silently caching it', () => {
    expect(() =>
      parseGitDiffRecords(`:100644 100644 ${old} ${next} R100\0old\0`),
    ).toThrow();
    expect(() => parseGitDiffRecords('1\t0\tmissing\0')).toThrow();
    expect(parseGitDiffRecords('')).toEqual([]);
  });
});
