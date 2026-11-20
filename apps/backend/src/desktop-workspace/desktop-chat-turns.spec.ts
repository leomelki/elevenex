import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { SESSION_CHAT_TURN_TIMELINE_BYTES } from '@elevenex/shared';
import { ChatCompletedTurns } from './desktop-chat-turns.js';
import { ChatHistoryIndex, chatWindow } from './desktop-chat-window.js';
import { ChatToolDetails } from './desktop-chat-tool-details.js';

const stamp = '2026-11-19T10:00:00.000Z';
function row(id: string, kind: AgentTranscriptItem['kind'], content = id): AgentTranscriptItem {
  return { id, kind, content, timestamp: stamp };
}
function activity(prefix: string, count: number): AgentTranscriptItem[] {
  return Array.from({ length: count }, (_, index) => ({
    ...row(`${prefix}-read-${index}`, 'tool_use', ''),
    toolKind: 'read', toolInput: { file_path: `src/${index}.ts` },
  }));
}

describe('completed turn history', () => {
  it('discloses the latest version of each saved block in ordinary transcript order', () => {
    const history: AgentTranscriptItem[] = [
      row('prompt', 'user'),
      row('msg_split:thinking:0', 'thinking', ''),
      row('progress', 'assistant', 'Checked the entry point.'),
      row('msg_split:thinking:0', 'thinking', 'Completed reasoning'),
      row('checkpoint', 'system'),
      row('msg_final:assistant:0', 'assistant', 'Early reply'),
      row('msg_final:assistant:0', 'assistant', 'Complete reply'),
    ];
    const turns = new ChatCompletedTurns();
    const toolDetails = new ChatToolDetails(new WeakMap(), new WeakMap());
    const full = chatWindow(history, [], { loadingMode: 'window', toolDetails })!;
    const saved = chatWindow(history, [], { completedTurns: turns, summarizeRecent: true, toolDetails })!
      .items[0].completedTurn!;
    expect(saved).toMatchObject({ total: 3, beforeReply: 3, reply: [{ text: 'Complete reply' }] });
    const page = turns.page(history, saved.revision, 0, toolDetails, 512)!;
    expect(page).toMatchObject({ nextOffset: null, total: 3 });
    expect([...page.items, ...saved.reply]).toEqual(full.items.slice(1));
    expect(page.items[0].text).toBe('Completed reasoning');
    const appended = [...history, row('next', 'user'), row('next-reply', 'assistant')];
    const following = chatWindow(appended, [], { following: saved.endId, completedTurns: new ChatCompletedTurns() })!;
    expect(following.items.map(item => item.id)).toEqual(['next', 'next-reply']);
  });

  it('counts displayed calls and standalone failures using the final paired result', () => {
    const history: AgentTranscriptItem[] = [
      row('prompt', 'user'),
      { ...row('test', 'tool_use', ''), toolKind: 'bash', toolUseId: 'test' },
      { ...row('test-first', 'tool_result'), toolUseId: 'test', isError: true },
      row('orphan', 'tool_result'),
      { ...row('orphan-error', 'tool_result'), toolKind: 'read', isError: true },
      row('agent-error', 'error'),
      row('answer', 'assistant'),
      { ...row('test-final', 'tool_result'), toolUseId: 'test', providerToolResult: { exitCode: 0 } },
    ];
    const summary = new ChatCompletedTurns().summarize(history, 0, history.length, new Set(), undefined, true)?.completedTurn;
    expect(summary).toMatchObject({ counts: { run: 1, tool: 3 }, failures: 2, beforeReply: 5, total: 6 });
  });

  it('returns the visible reply and net changes without sending hidden evidence', () => {
    const turns = new ChatCompletedTurns();
    const evidence = 'private tool input and output '.repeat(1500);
    const history: AgentTranscriptItem[] = [
      row('prompt', 'user', 'Verify the retry path'),
      row('progress', 'assistant', 'Earlier progress update'),
      ...activity('turn', 120),
      { ...row('call', 'tool_use', ''), toolKind: 'bash', toolUseId: 'command', toolInput: { command: 'pnpm test' } },
      row('answer-a', 'assistant', 'The retry path is covered.'),
      row('answer-b', 'assistant', 'The final test is the exception.'),
      { ...row('receipt', 'tool_result', evidence), toolUseId: 'command', providerToolResult: { exitCode: 1 } },
      {
        ...row('changes', 'system', ''),
        timestamp: '2026-11-19T10:02:14.000Z',
        turnChanges: {
          files: 1, additions: 12, deletions: 4, filesChanged: [{
            path: 'src/retry.ts', status: 'modified', additions: 12, deletions: 4, hunks: [],
          }],
        },
      },
    ];
    const latest = chatWindow(history, [], { completedTurns: turns, loadingMode: 'progressive' })!;
    expect(latest.before).toBeNull();
    expect(latest.items.map(item => item.id)).toEqual(['prompt']);
    expect(JSON.stringify(latest)).not.toContain('private tool input');
    expect(JSON.stringify(latest)).not.toContain('Earlier progress update');
    const summary = latest.items[0].completedTurn!;
    expect(summary).toMatchObject({
      endId: 'changes', beforeReply: 122, total: 123, counts: { read: 120, run: 1 },
      failures: 1, duration: 134, changes: {
        files: [{ path: 'src/retry.ts', status: 'M', add: 12, del: 4 }], total: 1,
      },
    });
    expect(summary.reply.map(item => item.id)).toEqual(['answer-a', 'answer-b']);
    expect(Buffer.byteLength(JSON.stringify(latest))).toBeLessThan(2500);

    const seen = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = turns.page(history, summary.revision, offset)!;
      expect(page.items.length).toBeLessThanOrEqual(40);
      seen.push(...page.items);
      offset = page.nextOffset;
    }
    expect(seen.map(item => item.id)).toEqual(history.slice(1)
      .filter(item => !['answer-a', 'answer-b', 'changes'].includes(item.id)).map(item => item.id));
    expect(seen.at(-1)).toMatchObject({ id: 'receipt', error: true, truncated: true, execution: { exitCode: 1 } });
    expect(seen.at(-2)).toMatchObject({ id: 'call', receipt: { id: 'receipt', error: true } });
  });

  it('keeps only small recent work inline and preserves raw seams into a large live or partial turn', () => {
    const old = [row('old', 'user'), ...activity('old', 2), row('old-answer', 'assistant')];
    const big = [row('big', 'user'), ...activity('big', 90), row('big-answer', 'assistant')];
    const tiny = [row('tiny', 'user'), ...activity('tiny', 2), row('tiny-answer', 'assistant')];
    const history = [...old, ...big, ...tiny];
    const completedTurns = new ChatCompletedTurns();
    const options = { completedTurns, historyIndex: new ChatHistoryIndex() };
    const latest = chatWindow(history, [], options)!;
    expect(latest.items.map(item => item.id)).toEqual(['old', 'big', ...tiny.map(item => item.id)]);
    expect(latest.items.slice(0, 2).every(item => !!item.completedTurn)).toBe(true);
    expect(latest.items.slice(2).every(item => !item.completedTurn)).toBe(true);

    const live = chatWindow(history, [big[25]], { ...options, liveTurn: true })!;
    expect(live.items.some(item => item.id === 'big-answer')).toBe(true);
    expect(live.items.some(item => item.id === 'big' && item.completedTurn)).toBe(false);

    const middle = chatWindow(history, [], { ...options, before: 'big-read-18' })!;
    expect(middle.next).toBe('big-read-17');
    expect(middle.items.find(item => item.id === 'big')?.completedTurn).toBeUndefined();
    const forward = chatWindow(history, [], { ...options, following: middle.next! })!;
    expect(forward.items[0]?.id).toBe('big-read-18');
    expect(forward.items.some(item => item.completedTurn)).toBe(false);
  });

  it('fits hundreds of paired tools in one compact timeline and keeps media at the receipt position', () => {
    const turns = new ChatCompletedTurns();
    const calls = activity('large', 600);
    const results = calls.map(call => ({
      ...row(call.id + '-result', 'tool_result', 'Body that should only be read on demand.'), toolUseId: call.id,
    }));
    const image = { ...results.at(-1)!, images: [{ mediaType: 'image/png', data: 'aW1hZ2U=' }] };
    const timeline = calls.slice(0, -1).flatMap((call, index) => [call, results[index]]);
    const history = [row('prompt', 'user'), ...timeline, calls.at(-1)!, row('answer', 'assistant'), image];
    const summary = turns.summarize(history, 0, history.length, new Set())!.completedTurn!;
    const compact = turns.timeline(history, summary.revision, 0)!;
    expect(compact).toMatchObject({ total: 1200, nextOffset: null });
    expect(compact.timeline[1]).toBeNull();
    expect(compact.timeline.filter(Boolean)).toHaveLength(601);
    expect(compact.timeline[0]).toEqual({ kind: 'call', id: calls[0].id, label: 'src/0.ts', toolKind: 'read', resultId: results[0].id });
    expect(compact.timeline[summary.beforeReply]).toMatchObject({
      kind: 'media', id: image.id, callId: calls.at(-1)!.id,
      media: [{ id: '0', path: expect.stringContaining('chat-image-'), inline: true }],
    });
    const toolDetails = new ChatToolDetails(new WeakMap(), new WeakMap());
    const legacy = [0, 512, 1024].map(offset => turns.page(history, summary.revision, offset, toolDetails, 512)!.items).flat();
    const compactJson = JSON.stringify(compact.timeline);
    expect(compactJson).not.toContain('Body that should only be read');
    expect(Buffer.byteLength(compactJson)).toBeLessThan(Buffer.byteLength(JSON.stringify(legacy)) / 4);
  });

  it('continues an unusually large timeline at the first source slot outside its byte budget', () => {
    const turns = new ChatCompletedTurns();
    const work = Array.from({ length: 48 }, (_, i) => row(`note-${i}`, 'thinking', 'x'.repeat(16_000)));
    const history = [row('prompt', 'user'), ...work, row('answer', 'assistant')];
    const revision = turns.summarize(history, 0, history.length, new Set())!.completedTurn!.revision;
    const first = turns.timeline(history, revision, 0)!;
    expect(Buffer.byteLength(JSON.stringify(first.timeline))).toBeLessThanOrEqual(SESSION_CHAT_TURN_TIMELINE_BYTES);
    expect(first.nextOffset).toBe(first.timeline.length);
    const last = turns.timeline(history, revision, first.nextOffset!)!;
    expect(last.nextOffset).toBeNull();
    expect([...first.timeline, ...last.timeline].map(item => item?.id)).toEqual(work.map(item => item.id));
  });

  it('uses the raw end cursor to walk older and newer completed turns without gaps', () => {
    const history = Array.from({ length: 90 }, (_, index) => [
      row(`prompt-${index}`, 'user'), ...activity(`turn-${index}`, 9), row(`reply-${index}`, 'assistant'),
    ]).flat();
    const options = { completedTurns: new ChatCompletedTurns(), historyIndex: new ChatHistoryIndex() };
    const tail = chatWindow(history, [], options)!;
    const older = chatWindow(history, [], { ...options, before: tail.before! })!;
    expect(older.items.at(-1)?.completedTurn?.endId).toBe('reply-49');
    expect(older.next).toBe('reply-49');
    const following = chatWindow(history, [], { ...options, following: older.next! })!;
    expect(following.items).toEqual(tail.items);
    expect(following.next).toBeNull();
    expect(chatWindow(history, [], { ...options, before: older.before! })!.before).toBeNull();
  });

  it('keeps versions stable across appends and rejects same-id rewrites of hidden evidence', () => {
    const history = [row('prompt', 'user'), ...activity('turn', 12), row('answer', 'assistant')];
    const first = new ChatCompletedTurns().summarize(history, 0, history.length, new Set())!.completedTurn!;
    const appended = [...history, row('next-prompt', 'user')];
    expect(new ChatCompletedTurns().summarize(appended, 0, history.length, new Set())?.completedTurn?.revision).toBe(first.revision);
    const updated = history.map(item => item.id === 'turn-read-3' ? { ...item, toolInput: { path: 'new.ts' } } : item);
    expect(new ChatCompletedTurns().page(updated, first.revision, 0)).toBeNull();
  });

  it('ends an activity page at its byte budget and resumes from the first omitted row', () => {
    const work = Array.from({ length: 64 }, (_, index) =>
      row(`result-${index}`, 'tool_result', '💬'.repeat(16000)));
    const history = [row('prompt', 'user'), ...work, row('answer', 'assistant')];
    const turns = new ChatCompletedTurns();
    const { revision, total } = turns.summarize(history, 0, history.length, new Set())!.completedTurn!;
    const first = turns.page(history, revision, 0)!;
    expect(total).toBe(work.length);
    expect(first.items.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(385 * 1024);
    expect(turns.page(history, revision, first.nextOffset!)?.items[0].id).toBe(work[first.items.length].id);
  });
});
