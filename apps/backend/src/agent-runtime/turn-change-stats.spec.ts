import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import {
  computeTurnChangeDetailsFromItems,
  type TurnChangeDetails,
} from './turn-change-stats.js';

const item = (
  id: string,
  kind: ClaudeTranscriptItem['kind'],
  extra: Partial<ClaudeTranscriptItem> = {},
): ClaudeTranscriptItem => ({
  id,
  kind,
  timestamp: '2026-10-15T10:00:00.000Z',
  ...extra,
});
const snapshot: TurnChangeDetails = {
  files: 1,
  additions: 3,
  deletions: 1,
  capture: { root: '/repo', complete: true, shared: false },
  filesChanged: [
    {
      path: 'file.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      hunks: [],
      attribution: 'observed',
    },
  ],
};

describe('turn changes reconcile native events and observations', () => {
  it('uses the final net snapshot for edits followed by scripts to the same file without double-counting', () => {
    const details = computeTurnChangeDetailsFromItems([
      item('patch', 'tool_use', {
        toolName: 'FileChanges',
        toolKind: 'file_changes',
        toolUseId: 'patch',
        toolInput: {
          changes: [
            {
              path: '/repo/file.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
        },
      }),
      item('result', 'tool_result', { toolUseId: 'patch' }),
      item('capture', 'system', { turnChanges: snapshot }),
    ]);
    expect(details).toEqual(snapshot);
  });

  it('preserves explicitly edited files outside the snapshot scope and native edits on capture failure', () => {
    const call = item('edit', 'tool_use', {
      toolName: 'Write',
      toolUseId: 'edit',
      toolInput: { file_path: '/outside/file.ts', content: 'new\n' },
    });
    expect(
      computeTurnChangeDetailsFromItems([
        call,
        item('capture', 'system', { turnChanges: snapshot }),
      ])?.files,
    ).toBe(2);
    const failed = {
      ...snapshot,
      files: 0,
      additions: 0,
      deletions: 0,
      filesChanged: [],
      capture: {
        root: '/repo',
        complete: false,
        shared: false,
        message: 'Unavailable',
      },
    };
    const details = computeTurnChangeDetailsFromItems([
      call,
      item('capture', 'system', { turnChanges: failed }),
    ]);
    expect(details?.files).toBe(1);
    expect(details?.capture?.complete).toBe(false);
  });

  it('removes native edits that were reverted within the turn', () => {
    const call = item('edit', 'tool_use', {
      toolName: 'Write',
      toolUseId: 'edit',
      toolInput: { file_path: '/repo/file.ts', content: 'temporary\n' },
    });
    const reverted = {
      ...snapshot,
      files: 0,
      additions: 0,
      deletions: 0,
      filesChanged: [],
      capture: {
        root: '/repo',
        complete: true,
        shared: false,
        unchangedPaths: ['file.ts'],
      },
    };
    expect(
      computeTurnChangeDetailsFromItems([
        call,
        item('capture', 'system', { turnChanges: reverted }),
      ]),
    ).toBeNull();
  });

  it('reads historical native Claude Bash diffs including shared and non-rendered files', () => {
    const details = computeTurnChangeDetailsFromItems([
      item('bash', 'tool_use', {
        toolName: 'Bash',
        toolKind: 'bash',
        toolUseId: 'bash',
      }),
      item('result', 'tool_result', {
        toolUseId: 'bash',
        providerToolResult: {
          bashEditDiff: {
            shared: true,
            files: [
              {
                filePath: '/repo/file.ts',
                hunks: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ['-old', '+new'],
                  },
                ],
              },
            ],
            changedFiles: ['/repo/file.ts', '/repo/binary'],
          },
        },
      }),
    ]);
    expect(details).toMatchObject({ files: 2, additions: 1, deletions: 1 });
    expect(
      details?.filesChanged.every((file) => file.attribution === 'shared'),
    ).toBe(true);
    expect(details?.filesChanged[1].diffUnavailable).toBeTruthy();
  });
});

describe('native file-change metadata', () => {
  it.each([
    { kind: 'add', diff: 'hello\n', status: 'created', additions: 1, deletions: 0 },
    { kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new', status: 'modified', additions: 1, deletions: 1 },
    { kind: { type: 'delete' }, diff: 'old\n', status: 'deleted', additions: 0, deletions: 1 },
  ])('preserves native $status status and counts', ({ kind, diff, ...expected }) => {
    const details = computeTurnChangeDetailsFromItems([
      item('call', 'tool_use', { toolUseId: 'c', toolKind: 'file_changes', toolInput: { changes: [{ path: 'test.txt', kind, diff }] } }),
      item('result', 'tool_result', { toolUseId: 'c' }),
    ]);
    expect(details?.filesChanged[0]).toMatchObject(expected);
  });
});
