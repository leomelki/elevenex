import { codexAgentMessage } from './codex-agent-message.js';

describe('incoming Codex agent messages', () => {
  const header =
    'Message Type: MESSAGE\nTask name: /root\nSender: /root/item_artwork\nPayload:\n';
  it('keeps routing metadata when WebMC-style saved bodies are encrypted', () => {
    const message = codexAgentMessage({
      author: '/root/item_artwork',
      recipient: '/root',
      content: [
        { type: 'input_text', text: header },
        { type: 'encrypted_content', encrypted_content: 'secret ciphertext' },
      ],
    });
    expect(message).toMatchObject({
      kind: 'system',
      agentMessage: {
        sender: '/root/item_artwork',
        recipient: '/root',
        messageType: 'message',
        bodyUnavailable: true,
      },
    });
    expect(message?.content).not.toContain('Payload');
    expect(message?.content).not.toContain('secret ciphertext');
  });
  it.each(['Payload:', 'Payload'])(
    'separates a final result body from routing with %s',
    (label) => {
      const message = codexAgentMessage({
        content:
          header.replace('MESSAGE', 'FINAL_ANSWER').replace('Payload:', label) +
          '\n**Checked** the atlas.\n\n- Tests passed.',
      });
      expect(message?.agentMessage).toEqual({
        sender: '/root/item_artwork',
        recipient: '/root',
        messageType: 'result',
        body: '**Checked** the atlas.\n\n- Tests passed.',
        bodyUnavailable: false,
      });
    },
  );
  it('keeps ordinary authored messages and does not invent authors', () => {
    expect(
      codexAgentMessage({ author: '/root/reviewer', text: 'Review ready.' })
        ?.agentMessage?.body,
    ).toBe('Review ready.');
    expect(codexAgentMessage({ text: 'Normal assistant output.' })).toBeNull();
  });
});
