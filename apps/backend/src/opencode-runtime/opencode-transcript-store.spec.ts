import type { Message, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import { OpenCodeTranscriptStore } from './opencode-transcript-store.js';

const message: Message = {
  id: 'm',
  sessionID: 's',
  role: 'user',
  agent: 'build',
  model: { providerID: 'test', modelID: 'model' },
  time: { created: 1 },
};
const text = (value: string, id = 'p'): Part => ({
  id,
  sessionID: 's',
  messageID: 'm',
  type: 'text',
  text: value,
});

describe('OpenCode transcript reconciliation', () => {
  it('waits for the owning message before publishing text parts that could be prompts', () => {
    const store = new OpenCodeTranscriptStore();
    const prompt = text('Check');
    store.putPart(prompt);
    expect(store.partItems(prompt)).toEqual([]);
    store.appendDelta(prompt.id, ' the change.');
    const [ready] = store.putMessage(message);
    expect(store.partItems(ready)).toMatchObject([{ id: prompt.id, kind: 'user', content: 'Check the change.' }]);
    expect(store.putMessage(message)).toEqual([]);
  });

  it('keeps an active message and its tool receipt through a stale restore', () => {
    const store = new OpenCodeTranscriptStore();
    store.putMessage(message);
    const call = { id: 'tool', callID: 'call', sessionID: 's', messageID: 'm', type: 'tool', tool: 'read' } as const;
    const running: ToolPart = { ...call, state: { status: 'running', input: {}, time: { start: 1 } } };
    const done: ToolPart = { ...call, state: { status: 'completed', input: {}, time: { start: 1, end: 2 },
      output: 'Notes', metadata: {}, title: 'Read' } };
    store.putPart(text('Read the notes.'));
    store.putPart(done);
    store.putPart(text('Still reading', 'new'));
    store.reconcile([{ info: message, parts: [text('Read'), running] }], store.snapshot(), undefined, new Set([message.id]));
    expect(store.history().map(row => [row.id, row.content])).toEqual([
      ['p', 'Read the notes.'], ['tool', undefined], ['tool:result', 'Notes'], ['new', 'Still reading'],
    ]);
    store.reconcile([{ info: message, parts: [] }], store.snapshot(), message.id, new Set([message.id]));
    expect(store.history()).toEqual([]);
  });

  it('refreshes live content and keeps stable native part ordering', () => {
    const store = new OpenCodeTranscriptStore();
    store.putMessage(message);
    store.putPart(text('old'));
    const live = store.history();
    store.putPart(text('later', 'p2'));
    store.reconcile(
      [{ info: message, parts: [text('recovered'), text('later', 'p2')] }],
      store.snapshot(),
    );
    expect(store.refreshLiveItems(live)).toEqual([
      expect.objectContaining({ id: 'p', content: 'recovered' }),
    ]);
    expect(store.history().map((item) => item.id)).toEqual(['p', 'p2']);
  });
  it.each(['outdated', 'prefix plus missed tokens'])(
    'preserves concurrent deltas against %s snapshots',
    (snapshotText) => {
      const store = new OpenCodeTranscriptStore();
      store.putMessage(message);
      store.putPart(text('prefix'));
      const before = store.snapshot();
      store.appendDelta('p', ' plus');
      store.reconcile([{ info: message, parts: [text(snapshotText)] }], before);
      expect(store.history()[0].content).toBe(
        snapshotText.startsWith('prefix plus') ? snapshotText : 'prefix plus',
      );
    },
  );
  it('removes deleted or reverted content without removing new stream events', () => {
    const store = new OpenCodeTranscriptStore();
    store.putMessage(message);
    store.putPart(text('removed'));
    const before = store.snapshot();
    store.putMessage({ ...message, id: 'new', time: { created: 2 } });
    store.putPart({ ...text('live', 'new-part'), messageID: 'new' });
    store.reconcile([], before);
    expect(store.history().map((item) => item.content)).toEqual(['live']);
    store.reconcile(
      [{ info: message, parts: [text('hidden')] }],
      store.snapshot(),
      'm',
    );
    expect(store.history()).toEqual([]);
  });
  it('invalidates cached history on message metadata updates and deltas', () => {
    const store = new OpenCodeTranscriptStore();
    store.putMessage(message);
    store.putPart(text('a'));
    expect(store.history()[0].kind).toBe('user');
    store.putMessage({
      ...message,
      role: 'assistant',
      agent: 'plan',
    } as Message);
    store.appendDelta('p', 'b');
    expect(store.history()[0]).toMatchObject({
      kind: 'assistant',
      content: 'ab',
      contentType: 'plan',
    });
    const returned = store.history();
    returned.pop();
    expect(store.history()).toHaveLength(1);
  });
});
