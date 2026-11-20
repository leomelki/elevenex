import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { UNKNOWN_IGNORED_FILE_BASELINE, type TurnChangeDetails } from '../agent-runtime/turn-change-stats.js';
import { chatWindow } from './desktop-chat-window.js';
import { turnChangesPage } from './desktop-chat-changes.js';
import { ChatCompletedTurns } from './desktop-chat-turns.js';

const item = (
  id: string,
  kind: AgentTranscriptItem['kind'],
  extra: Partial<AgentTranscriptItem> = {},
): AgentTranscriptItem => ({
  id,
  kind,
  timestamp: '2026-10-30T12:00:00Z',
  ...extra,
});
const captured = (count = 1, lines = 1): TurnChangeDetails => ({
  files: count,
  additions: count * lines,
  deletions: 0,
  capture: { root: '/repo', complete: true, shared: false },
  filesChanged: Array.from({ length: count }, (_, i) => ({
    path: `file-${i}.txt`,
    status: 'created',
    additions: lines,
    deletions: 0,
    hunks: [
      {
        id: `h-${i}`,
        toolName: 'capture',
        label: 'Changes',
        oldString: '',
        newString: '',
        additions: lines,
        deletions: 0,
        patch:
          `@@ -0,0 +1,${lines} @@\n` +
          Array.from({ length: lines }, (_, n) => `+line ${n + 1}`).join('\n'),
      },
    ],
  })),
});

describe('desktop reply changes', () => {
  it('shows the same verified edits and line totals before loading work, in full history and in Review', () => {
    const snapshot = captured(4, 2);
    // A verified binary modification contributes a file even with no lines.
    snapshot.filesChanged[0] = { ...snapshot.filesChanged[0], additions: 0, hunks: [], diffUnavailable: 'Binary file changed' };
    snapshot.filesChanged.push(...Array.from({ length: 206 }, (_, index) => ({
      path: index === 0 ? 'ignored-config' : `ignored/output-${index}`,
      status: 'modified' as const, additions: 0, deletions: 0, hunks: [], diffUnavailable: UNKNOWN_IGNORED_FILE_BASELINE,
    })));
    snapshot.files = snapshot.filesChanged.length;
    const rows = [
      item('prompt', 'user'),
      item('write', 'tool_use', { toolUseId: 'write', toolKind: 'write', toolInput: { file_path: '/repo/ignored-config', content: 'verified\n' } }),
      item('written', 'tool_result', { toolUseId: 'write' }),
      item('answer', 'assistant', { content: 'Finished.' }),
      item('capture', 'system', { turnChanges: snapshot }),
    ];
    const full = chatWindow(rows, [], { loadingMode: 'window' })!.items[0].turnChanges!;
    const compact = chatWindow(rows, [], { completedTurns: new ChatCompletedTurns(), summarizeRecent: true })!
      .items[0].completedTurn?.changes;
    const review = turnChangesPage(rows, 'prompt', 0);
    expect(full.total).toBe(5);
    expect(full.files).toEqual(review.files.slice(0, 3));
    expect(review.files.find(file => file.path === '/repo/ignored-config')).toMatchObject({ status: 'A', add: 1 });
    expect(review.files.find(file => file.path === 'file-0.txt')).toBeDefined();
    expect(full.lineTotals).toEqual({ add: 7, del: 0 });
    expect(compact).toEqual(full);
  });

  it('deduplicates repeated native edits and preserves distinct edits in both saved formats', () => {
    const edit = (id: string, oldText: string, newText: string) => [
      item(id, 'tool_use', { toolUseId: id, toolKind: 'edit',
        toolInput: { file_path: 'retry.ts', old_string: oldText, new_string: newText } }),
      item(id + '-result', 'tool_result', { toolUseId: id }),
    ];
    const rows = [item('prompt', 'user'),
      ...edit('first', 'old()', 'new()'), ...edit('retry', 'old()', 'new()'), ...edit('second', 'oldAgain()', 'newAgain()'),
      item('answer', 'assistant', { content: 'Edited the retry path.' })];
    const full = chatWindow(rows, [], { loadingMode: 'window' })!.items[0].turnChanges;
    const compact = chatWindow(rows, [], { completedTurns: new ChatCompletedTurns(), summarizeRecent: true })!
      .items[0].completedTurn?.changes;
    expect(full).toEqual({ total: 1, files: [{ path: 'retry.ts', status: 'M', add: 2, del: 2 }] });
    expect(compact).toEqual(full);
    expect(turnChangesPage(rows, 'prompt', 0).files).toEqual(full?.files);
  });

  it('reserves the native change budget for tools that can report a file change', () => {
    const reads = Array.from({ length: 330 }, (_, i) => [
      item(`read-${i}`, 'tool_use', { toolUseId: `read-${i}`, toolKind: 'read', toolInput: { file_path: 'source.ts' } }),
      item(`receipt-${i}`, 'tool_result', { toolUseId: `read-${i}` }),
    ]).flat();
    const rows = [item('prompt', 'user'), ...reads,
      item('write', 'tool_use', { toolUseId: 'write', toolKind: 'write', toolInput: { file_path: 'new.txt', content: 'hello\n' } }),
      item('written', 'tool_result', { toolUseId: 'write' }),
      item('reply', 'assistant', { content: 'Created the file.' })];
    const compact = chatWindow(rows, [], { completedTurns: new ChatCompletedTurns(), summarizeRecent: true })!
      .items[0].completedTurn?.changes;
    expect(compact).toEqual({ total: 1, files: [{ path: 'new.txt', status: 'A', add: 1, del: 0 }] });
    expect(turnChangesPage(rows, 'prompt', 0).files).toEqual(compact?.files);
  });

  it('carries shared capture attribution through history and review', () => {
    const details = captured(2);
    details.capture!.shared = true;
    const rows = [item('u', 'user'), item('a', 'assistant', { content: 'Read the implementation.' }),
      item('capture', 'system', { turnChanges: details })];
    expect(chatWindow(rows, [])?.items.at(-1)?.changes).toMatchObject({ total: 2, shared: true });
    expect(turnChangesPage(rows, 'u', 0)).toMatchObject({ total: 2, shared: true });
  });
  it('keeps captured shell changes separate from truncated display text in live and saved history', () => {
    const rows = [
      item('u', 'user'),
      item('a', 'assistant', { content: 'Created file-0.txt.' }),
      item('capture', 'system', { turnChanges: captured() }),
    ];
    for (const [history, live] of [
      [rows, []],
      [[], rows],
    ]) {
      const page = chatWindow(history, live)!;
      expect(page.items.at(-1)?.changes).toEqual({
        files: [{ path: 'file-0.txt', status: 'A', add: 1, del: 0 }],
        total: 1,
      });
      expect(
        turnChangesPage([...history, ...live], 'u', 0, 'file-0.txt').content
          ?.lines,
      ).toEqual([{ id: '0:0', kind: 'add', newNumber: 1, text: 'line 1' }]);
    }
  });
  it('shows only completed successful native edits before a capture exists', () => {
    const call = item('write', 'tool_use', {
      toolUseId: 'w',
      toolKind: 'write',
      toolInput: { file_path: 'new.txt', content: 'hello\n' },
    });
    expect(chatWindow([], [call])?.items[0].changes).toBeUndefined();
    const result = item('r', 'tool_result', { toolUseId: 'w' });
    expect(chatWindow([], [call, result])?.items[1].changes?.files[0]).toEqual({
      path: 'new.txt',
      status: 'A',
      add: 1,
      del: 0,
    });
    expect(
      chatWindow([], [call, { ...result, isError: true }])?.items[1].changes,
    ).toBeUndefined();
    expect(
      turnChangesPage(
        [item('u', 'user'), call, { ...result, isError: true }],
        'u',
        0,
      ).total,
    ).toBe(0);
  });
  it('reconciles reverted paths and preserves native edits outside captured scope or on capture failure', () => {
    const call = item('call', 'tool_use', { toolUseId: 'call', toolKind: 'write', toolInput: { file_path: '/repo/temporary.txt', content: 'temporary\n' } });
    const result = item('result', 'tool_result', { toolUseId: 'call' });
    const snapshot = captured(0);
    snapshot.capture!.unchangedPaths = ['temporary.txt'];
    const rows = [item('u', 'user'), call, result, item('capture', 'system', { turnChanges: snapshot })];
    expect(chatWindow(rows, [])?.items.at(-1)?.changes).toEqual({ files: [], total: 0 });
    expect(turnChangesPage(rows, 'u', 0).total).toBe(0);
    call.toolInput = { file_path: '/outside/new.txt', content: 'saved\n' };
    expect(chatWindow(rows, [])?.items.at(-1)?.changes?.files[0].path).toBe('/outside/new.txt');
    expect(turnChangesPage(rows, 'u', 0).total).toBe(1);
    snapshot.capture!.complete = false;
    expect(turnChangesPage(rows, 'u', 0, '/outside/new.txt').content?.lines[0].text).toBe('saved');
  });

  it('pages thousands of files and hundreds of lines, matching exact file, reply and revision', () => {
    const rows = [
      item('u', 'user'),
      item('s', 'system', { turnChanges: captured(1001, 401) }),
      item('u2', 'user'),
    ];
    const summary = chatWindow(rows, [])?.items.find(
      (item) => item.id === 's',
    )?.changes;
    expect(summary?.files).toHaveLength(200);
    expect(summary?.total).toBe(1001);
    const page = turnChangesPage(rows, 'u', 0, 'file-1000.txt');
    expect(page.offset).toBe(1000);
    expect(page.files).toHaveLength(1);
    expect(page.content?.lines).toHaveLength(400);
    expect(page.content?.nextOffset).toBe(400);
    const next = turnChangesPage(
      rows,
      'u',
      0,
      'file-1000.txt',
      400,
      page.revision,
    );
    expect(next.content?.lines).toHaveLength(1);
    expect(next.content?.lines[0].newNumber).toBe(401);
    expect(next.content?.nextOffset).toBeNull();
    expect(() => turnChangesPage(rows, 'u2', 0, 'file-0.txt')).toThrow();
    expect(() =>
      turnChangesPage(rows, 'u', 0, 'file-0.txt', 0, '0'.repeat(64)),
    ).toThrow();
    expect(() => turnChangesPage(rows, 'missing', 0)).toThrow();
  });
  it('preserves net-zero captured turns and unavailable binary diffs', () => {
    const empty = captured(0);
    expect(
      turnChangesPage(
        [item('u', 'user'), item('s', 'system', { turnChanges: empty })],
        'u',
        0,
      ).files,
    ).toEqual([]);
    const binary = captured();
    binary.filesChanged[0].hunks = [];
    binary.filesChanged[0].diffUnavailable = 'Binary file';
    expect(
      turnChangesPage(
        [item('u', 'user'), item('s', 'system', { turnChanges: binary })],
        'u',
        0,
        'file-0.txt',
      ).content?.error,
    ).toBe('Binary file');
  });
});
