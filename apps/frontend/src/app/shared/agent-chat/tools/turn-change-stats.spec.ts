import { computeTurnChangeDetails, computeTurnChangeDetailsFromItems, type TurnChangeDetails } from '@/shared/agent-chat/tools/turn-change-stats';
import type { PairedTranscriptUnit } from '@/shared/agent-chat/transcript/paired-transcript';
import { describe, expect, it } from 'vitest';

describe('turn-change-stats', () => {
  it('prefers captured net changes over overlapping native edit events and retains shell-only files', () => {
    const capture: TurnChangeDetails = { files: 2, additions: 4, deletions: 1,
      capture: { root: '/repo', complete: true, shared: true }, filesChanged: [
        { path: 'a.ts', status: 'modified', additions: 3, deletions: 1, hunks: [], attribution: 'shared' },
        { path: 'from-python.ts', status: 'created', additions: 1, deletions: 0, hunks: [], attribution: 'shared' },
      ] };
    const details = computeTurnChangeDetailsFromItems([
      { id: 'edit', kind: 'tool_use', toolName: 'Edit', toolUseId: 'edit', timestamp: '', toolInput: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } },
      { id: 'capture', kind: 'system', timestamp: '', turnChanges: capture },
    ]);
    expect(details).toEqual(capture);
  });

  it('reads native Claude shell diffs when replaying a historical turn', () => {
    const details = computeTurnChangeDetailsFromItems([
      { id: 'bash', kind: 'tool_use', toolName: 'Bash', toolUseId: 'bash', timestamp: '' },
      { id: 'result', kind: 'tool_result', toolUseId: 'bash', timestamp: '', providerToolResult: { bashEditDiff: {
        shared: true, files: [{ filePath: 'a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }],
      } } },
    ]);
    expect(details).toMatchObject({ files: 1, additions: 1, deletions: 1 });
    expect(details?.filesChanged[0].attribution).toBe('shared');
  });

  it('infers edit hunk start lines from numbered tool results', () => {
    const units: PairedTranscriptUnit[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        toolUseId: 'tool-1',
        call: {
          id: 'tool-1',
          kind: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'Edit',
          toolInput: {
            file_path: 'src/app.ts',
            old_string: 'const b = 2;',
            new_string: 'const b = 3;',
          },
          timestamp: '2026-05-13T10:00:00.000Z',
        },
        result: {
          id: 'result-1',
          kind: 'tool_result',
          toolUseId: 'tool-1',
          content: [
            'The file has been updated. Here is a snippet:',
            '  40→const a = 1;',
            '  41→const b = 3;',
            '  42→const c = 4;',
          ].join('\n'),
          timestamp: '2026-05-13T10:00:01.000Z',
        },
      },
    ];

    const details = computeTurnChangeDetails(units);

    expect(details?.filesChanged[0].hunks[0].oldStartLine).toBe(41);
    expect(details?.filesChanged[0].hunks[0].newStartLine).toBe(41);
  });

  it('summarizes batched Pi edits', () => {
    const units: PairedTranscriptUnit[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        toolUseId: 'tool-1',
        call: {
          id: 'tool-1',
          kind: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'edit',
          toolInput: {
            file_path: 'src/app.ts',
            edits: [
              { old_string: 'const a = 1;', new_string: 'const a = 2;' },
              { old_string: 'const b = 1;', new_string: 'const b = 2;' },
            ],
          },
          timestamp: '2026-07-31T10:00:00.000Z',
        },
        result: {
          id: 'result-1',
          kind: 'tool_result',
          toolUseId: 'tool-1',
          content: 'Successfully replaced 2 blocks.',
          timestamp: '2026-07-31T10:00:01.000Z',
        },
      },
    ];

    const details = computeTurnChangeDetails(units);

    expect(details).toMatchObject({ files: 1, additions: 2, deletions: 2 });
    expect(details?.filesChanged[0].hunks).toHaveLength(2);
  });
});
