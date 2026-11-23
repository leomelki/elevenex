import {
  claudeEdit,
  codexPatch,
  openCodeEdits,
} from './turn-change-evidence.js';

describe('provider change receipts', () => {
  it('reads Codex literal add/delete content and a move with an update', () => {
    const { files, partial } = codexPatch(
      [
        {
          path: 'new.patch',
          kind: { type: 'add' },
          diff: '@@ -1 +1 @@\n-old\n+new\n',
        },
        { path: 'deleted', kind: { type: 'delete' }, diff: '-old literal\n' },
        {
          path: 'before',
          kind: { type: 'update', move_path: 'after' },
          diff: '@@ -1 +1 @@\n-before\n+after\n\nMoved to: after',
        },
      ],
      'edit',
      '/repo',
      '/repo',
    );
    expect(partial).toBe(false);
    expect(files).toEqual([
      expect.objectContaining({
        path: 'new.patch',
        status: 'created',
        additions: 3,
        deletions: 0,
        attribution: 'tool',
      }),
      expect.objectContaining({
        path: 'deleted',
        status: 'deleted',
        additions: 0,
        deletions: 1,
      }),
      expect.objectContaining({
        path: 'before',
        status: 'deleted',
        diffUnavailable: 'Moved to after',
      }),
      expect.objectContaining({
        path: 'after',
        status: 'created',
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

  it('uses OpenCode native multi-file and single-file patch receipts', () => {
    const move = openCodeEdits(
      {
        files: [
          {
            filePath: '/repo/old',
            type: 'move',
            movePath: '/repo/new',
            patch: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      },
      'apply',
      'Apply patch',
      '/repo',
      '/repo',
    );
    expect(move).toMatchObject([
      { path: 'old', status: 'deleted' },
      { path: 'new', status: 'created', additions: 1 },
    ]);
    const single = openCodeEdits(
      { filediff: { file: '/repo/edit', patch: '@@ -5 +5 @@\n-b\n+a' } },
      'editor',
      'Edit',
      '/repo',
      '/repo',
    );
    expect(single).toMatchObject([
      {
        path: 'edit',
        status: 'modified',
        additions: 1,
        deletions: 1,
        attribution: 'tool',
      },
    ]);
  });

  it('uses authoritative Claude overwrite contents when structured hunks are absent', () => {
    expect(
      claudeEdit(
        {
          type: 'update',
          filePath: '/repo/file',
          originalFile: 'previous\n',
          content: 'written\n',
        },
        'Write',
        'write',
        '/repo',
        '/repo',
      ),
    ).toMatchObject({
      partial: false,
      files: [
        {
          path: 'file',
          status: 'modified',
          additions: 1,
          deletions: 1,
          hunks: [{ patch: expect.stringContaining('-previous\n+written') }],
        },
      ],
    });
  });

  it('uses Claude structured receipt hunks and preserves a bounded file record for oversized patches', () => {
    const receipt = {
      filePath: '/repo/a',
      structuredPatch: [
        {
          oldStart: 14,
          oldLines: 1,
          newStart: 14,
          newLines: 1,
          lines: ['-old', '+new'],
        },
      ],
    };
    expect(claudeEdit(receipt, 'Edit', 'tool', '/repo', '/repo')).toMatchObject(
      {
        partial: false,
        files: [
          {
            path: 'a',
            attribution: 'tool',
            additions: 1,
            deletions: 1,
            hunks: [{ patch: expect.stringContaining('@@ -14,1 +14,1 @@') }],
          },
        ],
      },
    );
    expect(
      codexPatch(
        [{ path: 'large', kind: { type: 'add' }, diff: 'a'.repeat(300_000) }],
        'edit',
        '/repo',
        '/repo',
      ),
    ).toMatchObject({
      partial: true,
      files: [
        {
          path: 'large',
          status: 'created',
          hunks: [],
          diffUnavailable: expect.stringContaining('limit'),
        },
      ],
    });
  });
});
