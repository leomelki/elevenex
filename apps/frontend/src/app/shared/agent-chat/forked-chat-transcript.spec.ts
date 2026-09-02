import { describe, expect, it } from 'vitest';
import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import {
  ForkedChatTranscript,
  type ForkedChatLens,
} from './forked-chat-transcript';

const QUESTION_RE = /<q>\s*([\s\S]*?)\s*<\/q>/i;

const lens: ForkedChatLens = {
  sanitizeUserContent: (content) => {
    const text = content ?? '';
    return (QUESTION_RE.exec(text)?.[1] ?? text).trim();
  },
  isOwnPrompt: (item) => QUESTION_RE.test(item.content ?? ''),
};

function item(
  overrides: Partial<ClaudeTranscriptItem> & Pick<ClaudeTranscriptItem, 'id' | 'kind'>,
): ClaudeTranscriptItem {
  return {
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ClaudeTranscriptItem;
}

describe('ForkedChatTranscript', () => {
  it('hides the inherited parent conversation before the first own prompt', () => {
    const transcript = new ForkedChatTranscript(lens);

    transcript.history.set([
      item({ id: 'p1', kind: 'user', content: 'original task', timestamp: '1' }),
      item({ id: 'p2', kind: 'assistant', content: 'doing it', timestamp: '2' }),
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '3' }),
      item({ id: 'a1', kind: 'assistant', content: 'because', timestamp: '4' }),
    ]);

    expect(transcript.items().map((entry) => entry.id)).toEqual(['q1', 'a1']);
  });

  it('shows nothing until this surface has asked something', () => {
    const transcript = new ForkedChatTranscript(lens);

    transcript.history.set([
      item({ id: 'p1', kind: 'user', content: 'original task', timestamp: '1' }),
      item({ id: 'p2', kind: 'assistant', content: 'doing it', timestamp: '2' }),
    ]);

    expect(transcript.items()).toEqual([]);
  });

  it('strips the guard wrapper from displayed user messages', () => {
    const transcript = new ForkedChatTranscript(lens);
    const entry = { id: 'q1', kind: 'user' as const, content: '<q>why?</q>' };

    expect(transcript.displayContent(entry as never)).toBe('why?');
  });

  it('renders an optimistic prompt immediately', () => {
    const transcript = new ForkedChatTranscript(lens);

    transcript.addOptimisticPrompt('why?');

    expect(transcript.items().map((entry) => entry.content)).toEqual(['why?']);
  });

  it('drops an optimistic prompt once history contains the same question', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.addOptimisticPrompt('why?');

    transcript.applyHistoryRefresh([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '3' }),
    ]);

    expect(transcript.optimistic()).toEqual([]);
    expect(transcript.items().map((entry) => entry.id)).toEqual(['q1']);
  });

  it('shows a streaming answer only once after it is persisted', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.history.set([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
    ]);
    transcript.live.set([
      item({
        id: 'msg_a:1',
        kind: 'assistant',
        content: 'because',
        sourceMessageId: 'uuid-a',
        timestamp: '2',
      }),
    ]);

    expect(transcript.items()).toHaveLength(2);

    transcript.applyHistoryRefresh([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
      item({
        id: 'msg_a:assistant:0',
        kind: 'assistant',
        content: 'because',
        sourceMessageId: 'uuid-a',
        timestamp: '2',
      }),
    ]);

    expect(transcript.items()).toHaveLength(2);
    expect(transcript.live()).toEqual([]);
  });

  it('keeps a second answer that started streaming during a history refresh', () => {
    // The refresh only knows about the first answer. Clearing live items
    // outright here would silently swallow the one still arriving.
    const transcript = new ForkedChatTranscript(lens);
    transcript.history.set([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
    ]);
    transcript.live.set([
      item({
        id: 'msg_a:1',
        kind: 'assistant',
        content: 'first',
        sourceMessageId: 'uuid-a',
        timestamp: '2',
      }),
      item({
        id: 'msg_b:1',
        kind: 'assistant',
        content: 'second',
        sourceMessageId: 'uuid-b',
        timestamp: '3',
      }),
    ]);

    transcript.applyHistoryRefresh([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
      item({
        id: 'msg_a:assistant:0',
        kind: 'assistant',
        content: 'first',
        sourceMessageId: 'uuid-a',
        timestamp: '2',
      }),
    ]);

    expect(transcript.live().map((entry) => entry.content)).toEqual(['second']);
    expect(
      transcript.items().map((entry) => transcript.displayContent(entry)),
    ).toEqual(['why?', 'first', 'second']);
  });

  it('never drops live items that have no source message id', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.history.set([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
    ]);
    transcript.live.set([
      item({ id: 'local-only', kind: 'assistant', content: 'partial', timestamp: '2' }),
    ]);

    transcript.applyHistoryRefresh([
      item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
    ]);

    expect(transcript.live().map((entry) => entry.id)).toEqual(['local-only']);
  });

  it('distinguishes a user and an assistant sharing one source message id', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.history.set([
      item({
        id: 'q1',
        kind: 'user',
        content: '<q>why?</q>',
        sourceMessageId: 'uuid-shared',
        timestamp: '1',
      }),
    ]);
    transcript.live.set([
      item({
        id: 'a-live',
        kind: 'assistant',
        content: 'because',
        sourceMessageId: 'uuid-shared',
        timestamp: '2',
      }),
    ]);

    // The assistant item must survive: the key is (sourceMessageId, kind).
    expect(transcript.items().map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('appends streaming deltas to the matching live item', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.apply({
      type: 'message_start',
      payload: { item: item({ id: 'a1', kind: 'assistant', content: 'be' }) },
    } as never);

    transcript.apply({
      type: 'message_delta',
      payload: { itemId: 'a1', delta: 'cause' },
    } as never);

    expect(transcript.live()[0].content).toBe('because');
  });

  it('clears the running state when a turn completes', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.runPhase.set('running');
    transcript.canInterrupt.set(true);

    transcript.apply({ type: 'complete', payload: {} } as never);

    expect(transcript.runPhase()).toBe('idle');
    expect(transcript.canInterrupt()).toBe(false);
  });

  it('surfaces runtime errors', () => {
    const transcript = new ForkedChatTranscript(lens);

    transcript.apply({
      type: 'error',
      payload: { message: 'runtime exploded' },
    } as never);

    expect(transcript.lastError()).toBe('runtime exploded');
  });

  it('resets every bucket', () => {
    const transcript = new ForkedChatTranscript(lens);
    transcript.history.set([item({ id: 'q1', kind: 'user', content: '<q>a</q>' })]);
    transcript.addOptimisticPrompt('b');
    transcript.lastError.set('boom');

    transcript.reset();

    expect(transcript.items()).toEqual([]);
    expect(transcript.lastError()).toBeNull();
  });
});
