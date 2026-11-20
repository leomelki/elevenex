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


describe('Codex generated image history', () => {
  it('retains saved image references and native PNG results after reload', () => {
    for (const image of [{ saved_path: '/home/user/.codex/generated_images/robot.png' }, { result: 'cG5n' }]) {
      const { native } = codexHistoryTools([{ type: 'event_msg', timestamp: '2026-11-01T12:00:00Z',
        payload: { type: 'item_completed', item: { id: 'image', type: 'ImageGeneration', status: 'completed', ...image } } }]);
      expect(native.get(0)?.[1]).toMatchObject({ kind: 'tool_result', providerToolResult: {
        content: [{ type: 'image', image_url: image.saved_path ?? 'data:image/png;base64,cG5n' }],
      } });
    }
  });
});

describe('Codex viewed images', () => {
  it('restores image operations alongside commands and keeps an interrupted wrapper from another turn', () => {
    const record = (type: string, payload: Record<string, unknown>) => ({
      timestamp: '2026-11-19T12:00:00Z', type, payload,
    });
    const wrapper = (call_id: string) =>
      record('response_item', { type: 'custom_tool_call', call_id, name: 'exec' });
    const { native, wrappers } = codexHistoryTools([
      wrapper('interrupted'),
      record('event_msg', { type: 'turn_aborted' }),
      wrapper('preview'),
      record('event_msg', { type: 'item_completed', item: {
        type: 'ImageView', id: 'image', path: 'file:///repo/my%20preview.png',
      } }),
      record('event_msg', { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'command', status: 'completed', command: 'pnpm test',
      } }),
    ]);
    expect(wrappers).toEqual(new Set(['preview']));
    expect(native.get(3)).toMatchObject([
      { id: 'image:tool_use', toolKind: 'image_view', toolInput: { path: '/repo/my preview.png' } },
      { id: 'image:tool_result', toolUseId: 'image', isError: false,
        providerToolResult: { content: [{ type: 'image', image_url: '/repo/my preview.png' }] } },
    ]);
    expect(native.get(4)?.[0]?.id).toBe('command:tool_use');
  });
});
