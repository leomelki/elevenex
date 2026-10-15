import { claudeAgentMessageContent } from './claude-agent-message.js';

const envelope =
  '<agent-message from="af8cdb1911fc5f307">\n[Subagent hand-back] Tests passed.\n\nDetails preserved.\n</agent-message>';

describe('Claude agent message envelopes', () => {
  it.each([envelope, `Another Claude session sent a message:\n${envelope}`])(
    'formats a hand-back for the shared system message UI',
    (text) => {
      expect(claudeAgentMessageContent(text)).toBe(
        'Received a final response from af8cdb1911fc5f307.\n\n[Subagent hand-back] Tests passed.\n\nDetails preserved.',
      );
    },
  );

  it('accepts ordinary messages, CRLF, and additional envelope attributes', () => {
    expect(
      claudeAgentMessageContent(
        'Another Claude session sent a message:\r\n<agent-message priority="normal" from=\'reviewer\'>\r\nStill reviewing.\r\n</agent-message>',
      ),
    ).toBe('Received a message from reviewer.\n\nStill reviewing.');
  });

  it.each([
    `Explain this:\n${envelope}`,
    `\`\`\`xml\n${envelope}\n\`\`\``,
    `> ${envelope}`,
    `    ${envelope}`,
    `\`${envelope}\``,
    `${envelope}\nPlease review this`,
    '<agent-message from="reviewer">Unfinished',
    '<agent-message>No sender</agent-message>',
    '<agent-message from="">No sender</agent-message>',
    '<agent-message from="reviewer"> </agent-message>',
    '<agent-message notfrom="reviewer">Invalid attribute</agent-message>',
    'Please continue',
  ])('preserves human prompts and invalid envelopes: %s', (text) => {
    expect(claudeAgentMessageContent(text)).toBeNull();
  });
});
