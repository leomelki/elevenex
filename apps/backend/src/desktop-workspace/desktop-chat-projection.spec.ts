import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatItem, chatWindow } from './desktop-chat-projection.js';

const command: AgentTranscriptItem = {
  id: 'command', kind: 'tool_use', timestamp: '2026-11-01T12:00:00Z',
  toolKind: 'bash', toolInput: { command: 'pnpm test', cwd: '/repo' },
};
const result = (providerToolResult: unknown): AgentTranscriptItem => ({
  id: 'result', kind: 'tool_result', timestamp: command.timestamp,
  content: 'test output', providerToolResult,
});

describe('desktop command facts', () => {
  it('retains reported exit and workspace separately from readable output', () => {
    const value = chatItem(result({ exit_code: -1, private: 'discard' }), command);
    expect(value.text).toBe('test output');
    expect(value.execution).toEqual({ exitCode: -1, cwd: '/repo' });
    expect(value.error).toBe(true);
    expect(chatItem(command).execution).toEqual({ cwd: '/repo' });
  });

  it('marks an interrupted command as unsuccessful without changing legacy data', () => {
    const raw = result({ interrupted: true, exitCode: 0 });
    expect(chatItem(raw, command)).toMatchObject({
      error: true, execution: { interrupted: true, exitCode: 0 },
    });
    expect(raw.isError).toBeUndefined();
  });

  it('keeps absent facts unknown and drops malformed or unrelated metadata', () => {
    const withoutCwd = { ...command, toolInput: { command: 'pnpm test' } };
    expect(chatItem(result(undefined), withoutCwd).execution).toBeUndefined();
    expect(chatItem(result({ exitCode: NaN, interrupted: 'false', cwd: 'x'.repeat(4001) }), withoutCwd).execution).toBeUndefined();
    expect(chatItem(result({ exitCode: 0 }), { ...command, toolKind: 'mcp', toolInput: {} }).execution).toBeUndefined();
  });
});

describe('bidirectional chat windows', () => {
  const history: AgentTranscriptItem[] = Array.from({ length: 10_000 }, (_, i) => ({
    id: String(i), kind: 'assistant', content: `Message ${i}`, timestamp: command.timestamp,
  }));
  it('walks a large history in bounded contiguous pages in either direction', () => {
    let page = chatWindow(history, [])!;
    expect(page.items).toHaveLength(80); expect(page.next).toBeNull();
    for (let i = 0; i < 100; i++) {
      page = chatWindow(history, [], page.before!)!;
      expect(page.items.length).toBeLessThanOrEqual(80);
      expect(page.next).toBe(page.items.at(-1)!.id);
    }
    let position = page.next!;
    while (page.next) {
      page = chatWindow(history, [], undefined, undefined, undefined, position)!;
      expect(Number(page.items[0]!.id)).toBe(Number(position) + 1);
      expect(page.items.length).toBeLessThanOrEqual(80);
      position = page.next!;
    }
    expect(page.items.at(-1)!.id).toBe('9999');
  });
  it('merges overlapping live records without duplicating or skipping the history seam', () => {
    const live = [...history.slice(-40), { ...history[0]!, id: '10000', content: 'New reply' }];
    const page = chatWindow(history, live, undefined, undefined, undefined, '9950')!;
    expect(page.items.map(item => item.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 9951)));
    expect(page.next).toBeNull();
    expect(chatWindow(history, live, undefined, undefined, undefined, 'missing')).toBeNull();
  });
  it('bounds forward payload bytes as well as item counts', () => {
    const long = history.slice(0, 100).map(item => ({ ...item, content: 'x'.repeat(32_000) }));
    const page = chatWindow(long, [], undefined, undefined, undefined, '0')!;
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThan(512 * 1024);
    expect(page.items.length).toBeGreaterThan(0); expect(page.next).not.toBeNull();
  });
});


describe('prompt context outside contiguous pages', () => {
  const history: AgentTranscriptItem[] = Array.from({ length: 4000 }, (_, index) => ({
    id: String(index), kind: index % 1000 === 0 ? 'user' : 'assistant',
    content: `Record ${index}`, timestamp: command.timestamp,
  }));
  it('carries the preceding prompt through every bounded page without skipping evidence', () => {
    let page = chatWindow(history, [])!;
    const ids = page.items.map(item => item.id);
    while (true) {
      const first = Number(page.items[0].id);
      expect(page.leadingPrompt?.id ?? null).toBe(first % 1000 ? String(Math.floor(first / 1000) * 1000) : null);
      expect(page.items.length).toBeLessThanOrEqual(80);
      if (!page.before) break;
      page = chatWindow(history, [], page.before)!;
      ids.unshift(...page.items.map(item => item.id));
    }
    expect(ids).toEqual(history.map(item => item.id));
    while (page.next) {
      const prior = Number(page.items.at(-1)!.id);
      page = chatWindow(history, [], undefined, undefined, undefined, page.next)!;
      expect(Number(page.items[0].id)).toBe(prior + 1);
      const first = Number(page.items[0].id);
      expect(page.leadingPrompt?.id ?? null).toBe(first % 1000 ? String(Math.floor(first / 1000) * 1000) : null);
    }
    expect(page.items.at(-1)?.id).toBe('3999');
  });
  it('finds persisted context for a live-only tail and prefers a newer live prompt', () => {
    const live = history.slice(-80).map(item => ({ ...item, id: `live-${item.id}` }));
    expect(chatWindow(history, live)!.leadingPrompt?.id).toBe('3000');
    live.unshift({ ...history[0], id: 'live-prompt', kind: 'user' });
    expect(chatWindow(history, live)!.leadingPrompt?.id).toBe('live-prompt');
  });
});
