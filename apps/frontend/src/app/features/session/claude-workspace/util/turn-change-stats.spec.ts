import { describe, expect, it } from 'vitest';
import { computeTurnChangeDetails } from './turn-change-stats';
import type { PairedTranscriptUnit } from './paired-transcript';

describe('turn-change-stats', () => {
  it('infers edit hunk start lines from numbered tool results', () => {
    const units: PairedTranscriptUnit[] = [{
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
    }];

    const details = computeTurnChangeDetails(units);

    expect(details?.filesChanged[0].hunks[0].oldStartLine).toBe(41);
    expect(details?.filesChanged[0].hunks[0].newStartLine).toBe(41);
  });
});
