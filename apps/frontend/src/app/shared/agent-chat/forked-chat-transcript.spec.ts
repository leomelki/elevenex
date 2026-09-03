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
    expect(transcript.items().map((entry) => entry.content)).toEqual([
      'why?',
      'first',
      'second',
    ]);
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
    transcript.backgroundWork.set([{ id: 'bg', kind: 'subagent' } as never]);

    transcript.reset();

    expect(transcript.items()).toEqual([]);
    expect(transcript.lastError()).toBeNull();
    expect(transcript.backgroundWork()).toEqual([]);
  });

  describe('rich transcript', () => {
    it('strips the guard wrapper from the rendered prompt, not just the preview', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.history.set([
        item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
      ]);

      expect(transcript.items()[0].content).toBe('why?');
    });

    it('keeps tool calls so they render as tool cards', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.history.set([
        item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
        item({
          id: 't1',
          kind: 'tool_use',
          toolUseId: 'toolu_1',
          toolName: 'Read',
          toolInput: { file_path: 'a.ts' },
          timestamp: '2',
        }),
        item({
          id: 't1r',
          kind: 'tool_result',
          toolUseId: 'toolu_1',
          content: 'file contents',
          timestamp: '3',
        }),
        item({ id: 'a1', kind: 'assistant', content: 'because', timestamp: '4' }),
      ]);

      const tool = transcript.units().find((unit) => unit.kind === 'tool');
      expect(tool).toBeDefined();
      expect(tool && tool.kind === 'tool' && tool.result?.content).toBe('file contents');
    });

    it('hides the parent session tool calls that came before the first own prompt', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.history.set([
        item({ id: 'p1', kind: 'user', content: 'original task', timestamp: '1' }),
        item({
          id: 'pt',
          kind: 'tool_use',
          toolUseId: 'toolu_parent',
          toolName: 'Bash',
          timestamp: '2',
        }),
        item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '3' }),
      ]);

      expect(transcript.items().map((entry) => entry.id)).toEqual(['q1']);
    });

    it('groups a settled turn behind a "Worked for" summary', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.history.set([
        item({
          id: 'q1',
          kind: 'user',
          content: '<q>why?</q>',
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
        item({
          id: 't1',
          kind: 'tool_use',
          toolUseId: 'toolu_1',
          toolName: 'Read',
          toolInput: { file_path: 'a.ts' },
          timestamp: '2026-01-01T00:00:01.000Z',
        }),
        item({
          id: 'a1',
          kind: 'assistant',
          content: 'because',
          timestamp: '2026-01-01T00:00:05.000Z',
        }),
      ]);

      const collapsed = transcript
        .renderItems()
        .find((entry) => entry.kind === 'collapsed-turn');
      expect(collapsed).toBeDefined();
      expect(collapsed?.kind === 'collapsed-turn' && collapsed.stepCount).toBe(1);
    });

    it('keeps a running turn expanded so tool work streams in live', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.runPhase.set('running');
      transcript.history.set([
        item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
        item({
          id: 't1',
          kind: 'tool_use',
          toolUseId: 'toolu_1',
          toolName: 'Read',
          toolInput: { file_path: 'a.ts' },
          timestamp: '2',
        }),
        item({ id: 'a1', kind: 'assistant', content: 'because', timestamp: '3' }),
      ]);

      expect(
        transcript.renderItems().some((entry) => entry.kind === 'collapsed-turn'),
      ).toBe(false);
    });

    it('groups subagent transcripts under the tool call that spawned them', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.history.set([
        item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
        item({
          id: 't1',
          kind: 'tool_use',
          toolUseId: 'toolu_1',
          toolName: 'Agent',
          timestamp: '2',
        }),
        item({
          id: 'c1',
          kind: 'assistant',
          content: 'child work',
          parentToolUseId: 'toolu_1',
          timestamp: '3',
        }),
      ]);

      expect(transcript.childItemsForToolUse('toolu_1').map((entry) => entry.id)).toEqual([
        'c1',
      ]);
      // Child items must not also appear at the top level.
      expect(transcript.topLevelItems().map((entry) => entry.id)).toEqual(['q1', 't1']);
    });

    it('tracks background work so it can be surfaced above the composer', () => {
      const transcript = new ForkedChatTranscript(lens);

      transcript.apply({
        type: 'background_work',
        payload: {
          backgroundWork: [
            { id: 'bg1', kind: 'subagent', label: 'Explore', startedAt: '1' },
          ],
        },
      } as never);

      expect(transcript.backgroundWork().map((entry) => entry.id)).toEqual(['bg1']);
    });

    it('holds a permission request until it resolves', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.live.set([
        item({ id: 't1', kind: 'tool_use', toolUseId: 'toolu_1', timestamp: '1' }),
      ]);

      transcript.apply({
        type: 'permission_request',
        payload: { request: { requestId: 'req-1', toolUseId: 'toolu_1' } },
      } as never);
      expect(transcript.pendingPermissionRequest()?.requestId).toBe('req-1');

      transcript.apply({
        type: 'permission_resolved',
        payload: {
          requestId: 'req-1',
          toolUseId: 'toolu_1',
          decision: 'approved',
          interaction: { kind: 'permission', tone: 'ok' },
        },
      } as never);

      expect(transcript.pendingPermissionRequest()).toBeNull();
      expect(transcript.live()[0].interaction).toEqual({ kind: 'permission', tone: 'ok' });
    });

    it('renders a runtime error inline instead of only in a banner', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.history.set([
        item({ id: 'q1', kind: 'user', content: '<q>why?</q>', timestamp: '1' }),
      ]);

      transcript.apply({
        type: 'error',
        payload: { message: 'runtime exploded' },
      } as never);

      expect(transcript.items().map((entry) => entry.kind)).toContain('error');
    });

    it('streams thinking deltas alongside message deltas', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.apply({
        type: 'thinking_start',
        payload: { item: item({ id: 'th1', kind: 'thinking', content: 'let me ' }) },
      } as never);
      transcript.apply({
        type: 'thinking_delta',
        payload: { itemId: 'th1', delta: 'check' },
      } as never);

      expect(transcript.live()[0].content).toBe('let me check');
      expect(transcript.lastLiveMessageId()).toBe('th1');
      expect(transcript.liveToolUseIds().size).toBe(0);
    });

    it('marks only the newest live item as streaming, and only while running', () => {
      const transcript = new ForkedChatTranscript(lens);
      transcript.runPhase.set('running');
      transcript.live.set([
        item({ id: 'a1', kind: 'assistant', content: 'first', timestamp: '1' }),
        item({ id: 'a2', kind: 'assistant', content: 'second', timestamp: '2' }),
      ]);

      expect(transcript.streamingMessageId()).toBe('a2');

      transcript.runPhase.set('idle');
      expect(transcript.streamingMessageId()).toBeNull();
    });
  });
});
