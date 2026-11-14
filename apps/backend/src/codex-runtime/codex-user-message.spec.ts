import { codexUserMessage } from './codex-user-message.js';

describe('Codex user receipts', () => {
  it.each(['userMessage', 'UserMessage'])(
    'reads %s without exposing injected context or image bytes',
    (type) => {
      expect(
        codexUserMessage({
          type,
          id: 'native-user',
          content: [
            {
              type: 'text',
              text: '<elevenex-worktree-context>private setup</elevenex-worktree-context>\n\nFollow up',
            },
            { type: 'image', imageUrl: 'data:image/png;base64,private' },
            { type: 'text', text: 'Keep APIs compatible.' },
          ],
        }),
      ).toEqual({
        id: 'native-user',
        text: 'Follow up\nKeep APIs compatible.',
      });
    },
  );

  it.each([
    null,
    {},
    { type: 'agentMessage', id: 'assistant', content: [{ text: 'Response' }] },
    { type: 'userMessage', content: [{ text: 'No identity' }] },
    { type: 'userMessage', id: 'empty', content: [{ text: '  ' }] },
    {
      type: 'userMessage',
      id: 'internal',
      kind: 'hook_prompt',
      content: [{ text: 'Hidden' }],
    },
    {
      type: 'userMessage',
      id: 'encrypted',
      content: [{ text: `gAAAAA${'a'.repeat(120)}` }],
    },
  ])('ignores malformed, internal or unreadable input: %j', (input) => {
    expect(codexUserMessage(input)).toBeNull();
  });
});
