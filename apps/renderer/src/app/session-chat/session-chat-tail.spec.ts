import { describe, expect, it } from 'vitest';
import type { SessionChatItem } from '@elevenex/shared';
import { chatTailContext } from './session-chat-tail';

const item = (id: string, kind: SessionChatItem['kind'], text = id): SessionChatItem => ({
  id, kind, text, timestamp: '', toolId: null, toolName: null, toolKind: null,
  input: '', error: false, truncated: false,
});

describe('discarded chat edge', () => {
  it('keeps each prompt with its latest reply and drops hidden intermediate work', () => {
    const records = [item('progress', 'assistant'), item('work', 'system'), item('reply', 'assistant'),
      item('next', 'user'), item('next-work', 'system'), item('next-reply', 'assistant')];
    expect(chatTailContext(records).map(item => item.id)).toEqual(['work', 'reply', 'next', 'next-work', 'next-reply']);
  });

  it('bounds turns, records and text by retaining whole nearest turns', () => {
    const turns = Array.from({ length: 1000 }, (_, i) => [item(`user-${i}`, 'user'), item(`reply-${i}`, 'assistant')]).flat();
    expect(chatTailContext(turns)).toEqual(turns.slice(0, 32));
    const large = Array.from({ length: 100 }, (_, i) => [item(`user-${i}`, 'user'), item(`reply-${i}`, 'assistant', 'x'.repeat(16000))]).flat();
    expect(chatTailContext(large).reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(256000);
    expect(chatTailContext(large).at(-1)?.kind).toBe('assistant');
    expect(chatTailContext(Array.from({ length: 100 }, (_, i) => item(String(i), 'assistant')))).toEqual([]);
  });
});
