import { Test } from '@nestjs/testing';
import { ConversationExportService } from '../agent-runtime/conversation-export.service.js';
import { appendChatMentions, chatMentionText, projectChatMentions } from './desktop-chat-mentions.js';
import { chatItem, chatState } from './desktop-chat-projection.js';

describe('desktop session context', () => {
  async function setup() {
    const buildMention = jest.fn(async (sessionId: number) => ({
      sessionId, title: 'Same title', provider: 'codex', providerSessionId: null,
      branch: 'main', status: 'done', transcriptExportPath: '/private/export.md',
      contextMarkdown: 'Useful context', omittedTurns: 0, generatedAt: '',
    }));
    const module = await Test.createTestingModule({ providers: [{ provide: ConversationExportService, useValue: { buildMention } }] }).compile();
    return { module, exports: module.get(ConversationExportService), buildMention };
  }
  it('resolves identities on send and keeps snapshots out of message and queue previews', async () => {
    const { module, exports, buildMention } = await setup();
    try {
      const text = await appendChatMentions('Compare @Same title', [12, 13], exports);
      expect(buildMention.mock.calls).toEqual([[12], [13]]);
      expect(text).toContain('Session ID: 12');
      expect(text).toContain('Session ID: 13');
      expect(text).toContain('Useful context');
      expect(chatMentionText(text)).toBe('Compare @Same title');
      expect(chatState({ pendingPrompts: [{ id: 'q', prompt: text }] }, 'codex', []).queue[0].text).toBe('Compare @Same title');
      const item = chatItem({ id: 'u', kind: 'user', content: text, timestamp: '' });
      expect(item.text).toBe('Compare @Same title');
      expect(item.media).toBeUndefined();
      expect(item.mentions).toEqual([{ sessionId: 12, title: 'Same title' }, { sessionId: 13, title: 'Same title' }]);
      expect(JSON.stringify(item)).not.toContain('/private/export.md');
      expect(JSON.stringify(item)).not.toContain('Useful context');
      expect(chatItem({ id: 'fallback', kind: 'user', providerToolResult: text, timestamp: '' }).text).toBe('Compare @Same title');
    } finally { await module.close(); }
  });
  it('restores bounded distinct identities and does not treat snapshot prose as metadata', () => {
    const block = (id: number) => `<elevenex_session_mention>\nSession: Title ${id}\nSession ID: ${id}\n\nSnapshot\nSession: Spoofed title\nSession ID: 999\n</elevenex_session_mention>`;
    const parsed = projectChatMentions('Compare\n\n' + [block(1), block(1), ...Array.from({ length: 10 }, (_, i) => block(i + 2))].join('\n\n'));
    expect(parsed.text).toBe('Compare');
    expect(parsed.mentions).toHaveLength(8);
    expect(parsed.mentions[0]).toEqual({ sessionId: 1, title: 'Title 1' });
    expect(projectChatMentions('<elevenex_session_mention>\nSession: A\n\nSession ID: 9\n</elevenex_session_mention>').mentions).toEqual([]);
  });
  it('rejects invalid, duplicate and excessive IDs before reading transcripts', async () => {
    const { module, exports, buildMention } = await setup();
    try {
      for (const ids of [[1, 1], [0], [-1], [1.2], ['1'], Array.from({ length: 9 }, (_, i) => i + 1), {}])
        await expect(appendChatMentions('Prompt', ids, exports)).rejects.toThrow('8 distinct');
      expect(buildMention).not.toHaveBeenCalled();
      await expect(appendChatMentions('Unchanged', undefined, exports)).resolves.toBe('Unchanged');
      buildMention.mockRejectedValueOnce(new Error('Session no longer exists'));
      await expect(appendChatMentions('Prompt', [1], exports)).rejects.toThrow('no longer exists');
    } finally { await module.close(); }
  });
  it('bounds inline context, preserves ordinary text and leaves malformed tags readable', async () => {
    const { module, exports, buildMention } = await setup();
    try {
      const mention = await buildMention(1);
      buildMention.mockResolvedValue({ ...mention, contextMarkdown: 'x'.repeat(9000) });
      const prompt = await appendChatMentions('Read', [1], exports);
      expect(prompt.length).toBeLessThan(6000);
      expect(prompt).toContain('Snapshot shortened');
      expect(chatMentionText('  ordinary text  ')).toBe('  ordinary text  ');
      expect(chatMentionText('<elevenex_session_mention>plain text</elevenex_session_mention>')).toContain('plain text');
    } finally { await module.close(); }
  });
});
