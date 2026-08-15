import { promises as fs } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeminiHistoryService } from './gemini-history.service.js';

describe('GeminiHistoryService chat files', () => {
  let dir: string;
  let service: GeminiHistoryService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gemini-chat-'));
    service = new GeminiHistoryService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Real shape from gemini-cli 0.55.1: a header line followed by `$set`
   * patches, where each `$set.messages` replaces the whole array.
   */
  async function writeChat(lines: unknown[]): Promise<string> {
    const path = join(dir, 'session-2026-08-15T22-44-9480c26c.jsonl');
    await fs.writeFile(
      path,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );
    return path;
  }

  it('folds $set patches so the last one wins', async () => {
    const path = await writeChat([
      { sessionId: 'abc', projectHash: 'h', kind: 'main' },
      {
        $set: {
          messages: [{ id: '1', type: 'user', content: [{ text: 'a' }] }],
        },
      },
      {
        $set: {
          messages: [
            { id: '1', type: 'user', content: [{ text: 'a' }] },
            { id: '2', type: 'gemini', content: [{ text: 'b' }] },
          ],
        },
      },
    ]);

    const file = await service.readChatFile(path);
    expect(file?.sessionId).toBe('abc');
    expect(file?.messages).toHaveLength(2);
    // The header survives separately so a fork can rewrite the file.
    expect(file?.header['projectHash']).toBe('h');
    expect(file?.header['messages']).toBeUndefined();
  });

  it('applies $push patches to arrays', async () => {
    const path = await writeChat([
      { sessionId: 'abc' },
      {
        $set: {
          messages: [{ id: '1', type: 'user', content: [{ text: 'a' }] }],
        },
      },
      {
        $push: {
          messages: { id: '2', type: 'gemini', content: [{ text: 'b' }] },
        },
      },
    ]);

    const file = await service.readChatFile(path);
    expect(file?.messages.map((m) => m['id'])).toEqual(['1', '2']);
  });

  it('skips unparseable lines rather than losing the conversation', async () => {
    const path = join(dir, 'session-broken.jsonl');
    await fs.writeFile(
      path,
      [
        JSON.stringify({ sessionId: 'abc' }),
        'not json at all',
        JSON.stringify({
          $set: {
            messages: [{ id: '1', type: 'user', content: [{ text: 'a' }] }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const file = await service.readChatFile(path);
    expect(file?.messages).toHaveLength(1);
  });

  it('returns null for a missing file', async () => {
    expect(await service.readChatFile(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('round-trips through writeChatFile', async () => {
    const path = join(dir, 'fork.jsonl');
    await service.writeChatFile(
      path,
      { sessionId: 'fork-id', projectHash: 'h' },
      [{ id: '1', type: 'user', content: [{ text: 'a' }] }],
    );

    const file = await service.readChatFile(path);
    expect(file?.sessionId).toBe('fork-id');
    expect(file?.messages).toHaveLength(1);
  });
});

describe('GeminiHistoryService.toTranscript', () => {
  const service = new GeminiHistoryService();

  it('strips the injected session context from the first user message', () => {
    const items = service.toTranscript([
      {
        id: '1',
        type: 'user',
        timestamp: '2026-08-15T22:44:51.440Z',
        content: [
          {
            text: '<session_context>\nbig tree\n</session_context>\nfix the bug',
          },
        ],
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('user');
    expect(items[0].content).toBe('fix the bug');
  });

  it('treats a non-user role as assistant output', () => {
    const items = service.toTranscript([
      { id: '2', type: 'gemini', content: [{ text: 'here you go' }] },
    ]);
    expect(items[0].kind).toBe('assistant');
    expect(items[0].contentType).toBe('message');
  });

  it('renders thought parts as thinking blocks', () => {
    const items = service.toTranscript([
      { id: '3', type: 'gemini', content: [{ text: 'hmm', thought: true }] },
    ]);
    expect(items[0].kind).toBe('thinking');
  });

  it('turns functionCall/functionResponse parts into tool items', () => {
    const items = service.toTranscript([
      {
        id: '4',
        type: 'gemini',
        content: [
          { functionCall: { name: 'read_file', args: { path: '/repo/a.ts' } } },
        ],
      },
      {
        id: '5',
        type: 'user',
        content: [
          { functionResponse: { id: '4', response: { output: 'file body' } } },
        ],
      },
    ]);

    expect(items[0].kind).toBe('tool_use');
    expect(items[0].toolKind).toBe('read');
    expect(items[0].providerToolName).toBe('read_file');
    expect(items[1].kind).toBe('tool_result');
    expect(items[1].content).toBe('file body');
  });

  it('drops empty parts instead of emitting blank bubbles', () => {
    expect(
      service.toTranscript([
        { id: '6', type: 'gemini', content: [{ text: '   ' }] },
      ]),
    ).toHaveLength(0);
  });
});
