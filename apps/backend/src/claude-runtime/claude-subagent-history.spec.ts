import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeChildTranscriptStore } from './claude-subagent-history.js';

const line = (i: number) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `message-${i}`,
    timestamp: `2026-10-12T10:${String(i).padStart(2, '0')}:00Z`,
    message: { content: [{ type: 'text', text: `Response ${i}` }] },
  }) + '\n';
describe('Claude incremental child history', () => {
  let root: string;
  let path: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-child-test-'));
    path = join(root, 'agent.jsonl');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('loads a bounded tail and earlier pages without overlap', async () => {
    await writeFile(
      path,
      Array.from({ length: 800 }, (_, i) => line(i)).join(''),
    );
    const store = new ClaudeChildTranscriptStore();
    const latest = await store.read(path);
    expect(latest.records).toHaveLength(300);
    expect(latest.records[0].uuid).toBe('message-500');
    const previous = await store.read(path, latest.records[0].uuid);
    expect(previous.records[0].uuid).toBe('message-200');
    expect(previous.records.at(-1)?.uuid).toBe('message-499');
    const first = await store.read(path, previous.records[0].uuid);
    expect(first.records).toHaveLength(200);
    expect(first.hasEarlier).toBe(false);
  });
  it('keeps an incomplete UTF8 record until the next append', async () => {
    const bytes = Buffer.from(line(1).replace('Response 1', 'Résumé 🐈'));
    const boundary = bytes.indexOf(Buffer.from('🐈')) + 2;
    await writeFile(
      path,
      Buffer.concat([Buffer.from(line(0)), bytes.subarray(0, boundary)]),
    );
    const store = new ClaudeChildTranscriptStore();
    expect(
      (await store.read(path)).records.map((record) => record.uuid),
    ).toEqual(['message-0']);
    await appendFile(path, bytes.subarray(boundary));
    const result = await store.read(path);
    expect(result.records.map((record) => record.uuid)).toEqual([
      'message-0',
      'message-1',
    ]);
    expect(JSON.stringify(result.records)).toContain('Résumé 🐈');
  });
  it('recovers a truncated or replaced transcript and skips malformed lines', async () => {
    await writeFile(path, line(1) + '{broken}\n' + line(2));
    const store = new ClaudeChildTranscriptStore();
    expect((await store.read(path)).records).toHaveLength(2);
    await writeFile(path, line(3));
    expect(
      (await store.read(path)).records.map((record) => record.uuid),
    ).toEqual(['message-3']);
  });
  it('isolates concurrent callers and does not repeat unchanged messages', async () => {
    await writeFile(path, line(1));
    const store = new ClaudeChildTranscriptStore();
    const [a, b] = await Promise.all([store.read(path), store.read(path)]);
    a.records[0].uuid = 'mutated';
    expect(b.records[0].uuid).toBe('message-1');
    expect((await store.read(path)).revision).toBe(b.revision);
    await appendFile(path, line(2));
    expect(
      (await store.read(path)).records.map((record) => record.uuid),
    ).toEqual(['message-1', 'message-2']);
  });
  it('loads an older page outside the retained cache', async () => {
    await writeFile(
      path,
      Array.from({ length: 5200 }, (_, i) => line(i)).join(''),
    );
    const store = new ClaudeChildTranscriptStore();
    const older = await store.read(path, 'message-1000');
    expect(older.records[0].uuid).toBe('message-700');
    expect(older.records.at(-1)?.uuid).toBe('message-999');
  });
});
