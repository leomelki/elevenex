import { describe, expect, it } from 'vitest';
import { parseFileChanges } from './file-changes';
import { computeTurnChangeDetails } from './turn-change-stats';

describe('file change presentation and statistics', () => {
  it('excludes patch headers for created and deleted files', () => {
    expect(
      parseFileChanges({
        changes: [
          {
            path: 'a.ts',
            kind: 'add',
            diff: '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+created\n',
          },
          {
            path: 'b.ts',
            kind: 'delete',
            diff: '--- a/b.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-deleted\n',
          },
        ],
      }).map((change) => [change.additions, change.deletions]),
    ).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('counts changed lines from a unified patch, excluding context and file headers', () => {
    const input = {
      changes: [
        {
          path: 'a.ts',
          kind: 'update',
          diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+new',
        },
      ],
    };
    expect(parseFileChanges(input)[0]).toMatchObject({ additions: 1, deletions: 1 });
    const details = computeTurnChangeDetails([
      {
        kind: 'tool',
        id: 'edit',
        toolUseId: 'edit',
        result: null,
        call: {
          id: 'edit',
          kind: 'tool_use',
          toolKind: 'file_changes',
          toolName: 'provider-specific-name',
          toolInput: input,
          timestamp: '1',
        },
      },
    ]);
    expect(details).toMatchObject({ files: 1, additions: 1, deletions: 1 });
  });

  it('counts raw content for created and deleted files', () => {
    expect(
      parseFileChanges({
        changes: [
          { path: 'created.ts', kind: 'add', diff: 'a\nb\n' },
          { path: 'deleted.ts', kind: { type: 'delete' }, diff: 'old\n' },
        ],
      }).map((change) => [change.additions, change.deletions]),
    ).toEqual([
      [2, 0],
      [0, 1],
    ]);
  });

  it('counts only replaced lines in edit blocks', () => {
    const details = computeTurnChangeDetails([
      {
        kind: 'tool',
        id: 'edit',
        toolUseId: 'edit',
        result: null,
        call: {
          id: 'edit',
          kind: 'tool_use',
          toolKind: 'edit',
          toolName: 'provider-specific-name',
          toolInput: {
            file_path: 'a.ts',
            old_string: 'unchanged\nold\n',
            new_string: 'unchanged\nnew\n',
          },
          timestamp: '1',
        },
      },
    ]);
    expect(details).toMatchObject({ additions: 1, deletions: 1 });
  });
});
