import { codexHistoryTools } from './codex-history-tools.js';

describe('Codex whole-file change receipts', () => {
  it('retains content identity through history decoding without changing legacy diff text', () => {
    const content = '@@ -1 +1 @@\n-old\n+new\n';
    const { native } = codexHistoryTools([{
      type: 'event_msg', timestamp: '2026-11-01T10:00:00Z',
      payload: { type: 'item_completed', item: {
        type: 'FileChange', id: 'files', status: 'completed',
        changes: {
          'created.patch': { type: 'add', content },
          'removed.txt': { type: 'delete', content: 'Hello\n' },
          'empty.txt': { type: 'add', content: '' },
          'changed.ts': { type: 'update', unified_diff: content },
        },
      } },
    }]);
    expect(native.get(0)?.[0]?.toolInput).toEqual({ changes: [
      { path: 'created.patch', kind: 'add', diff: content, diffFormat: 'content' },
      { path: 'removed.txt', kind: 'delete', diff: 'Hello\n', diffFormat: 'content' },
      { path: 'empty.txt', kind: 'add', diff: '', diffFormat: 'content' },
      { path: 'changed.ts', kind: 'update', diff: content },
    ] });
  });
});
