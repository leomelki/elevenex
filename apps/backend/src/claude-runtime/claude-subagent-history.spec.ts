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
    jest.restoreAllMocks();
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
  it('fills pages across and at the exact retained boundary', async () => {
    await writeFile(
      path,
      Array.from({ length: 5200 }, (_, i) => line(i)).join(''),
    );
    const store = new ClaudeChildTranscriptStore();
    const nearby = await store.read(path, 'message-1250');
    expect(nearby.records).toHaveLength(300);
    expect(nearby.records[0].uuid).toBe('message-950');
    const atBoundary = await store.read(path, 'message-1200');
    expect(atBoundary.records).toHaveLength(300);
    expect(atBoundary.records[0].uuid).toBe('message-900');
    expect(atBoundary.hasEarlier).toBe(true);
  });
  it('pages to the beginning without repeatedly scanning the whole file', async () => {
    await writeFile(
      path,
      Array.from({ length: 5200 }, (_, i) => line(i)).join(''),
    );
    const store = new ClaudeChildTranscriptStore();
    let page = await store.read(path);
    const ids = page.records.map((record) => record.uuid);
    const fs =
      jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
    const originalOpen = fs.open;
    let bytesRead = 0;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      jest
        .spyOn(handle, 'read')
        .mockImplementation(async (...readArgs: any[]) => {
          const result = await (read as any)(...readArgs);
          bytesRead += result.bytesRead;
          return result;
        });
      return handle;
    });
    while (page.hasEarlier) {
      bytesRead = 0;
      page = await store.read(path, page.records[0].uuid);
      expect(page.records.length).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThanOrEqual(128 * 1024);
      ids.unshift(...page.records.map((record) => record.uuid));
    }
    expect(ids).toEqual(Array.from({ length: 5200 }, (_, i) => `message-${i}`));
    expect((await store.read(path, 'message-0')).hasEarlier).toBe(false);
    const opens = fs.open as jest.Mock;
    opens.mockClear();
    await store.read(path);
    expect(opens).not.toHaveBeenCalled();
  });
  it('bounds byte-sized pages and preserves UTF8 lines spanning read chunks', async () => {
    const largeLine = (i: number) =>
      line(i).replace(`Response ${i}`, 'Résumé 🐈'.repeat(5000));
    await writeFile(
      path,
      Array.from({ length: 120 }, (_, i) => largeLine(i)).join(''),
    );
    const store = new ClaudeChildTranscriptStore();
    let page = await store.read(path);
    const records = [...page.records];
    while (page.hasEarlier) {
      page = await store.read(path, page.records[0].uuid);
      expect(page.records.length).toBeGreaterThan(0);
      expect(JSON.stringify(page.records).length * 2).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      records.unshift(...page.records);
    }
    expect(records.map((record) => record.uuid)).toEqual(
      Array.from({ length: 120 }, (_, i) => `message-${i}`),
    );
    expect(JSON.stringify(records)).toContain('Résumé 🐈');
  });
  it('coalesces older pages and skips malformed, metadata and unfinished lines', async () => {
    await writeFile(
      path,
      Array.from({ length: 5200 }, (_, i) => line(i)).join('') +
        '{broken}\n' +
        '{"type":"progress","uuid":"metadata"}\n' +
        '{"type":"assistant"',
    );
    const store = new ClaudeChildTranscriptStore();
    await store.read(path);
    const readBefore = jest.spyOn(store as any, 'readBefore');
    const [a, b] = await Promise.all([
      store.read(path, 'message-1000'),
      store.read(path, 'message-1000'),
    ]);
    expect(readBefore).toHaveBeenCalledTimes(1);
    expect(a.records[0].uuid).toBe('message-700');
    a.records[0].uuid = 'mutated';
    expect(b.records[0].uuid).toBe('message-700');
    expect((await store.read(path, 'missing')).records).toEqual([]);
  });
  it('does not reuse cursor offsets after truncation or replacement', async () => {
    await writeFile(
      path,
      Array.from({ length: 5200 }, (_, i) => line(i)).join(''),
    );
    const store = new ClaudeChildTranscriptStore();
    await store.read(path, 'message-1000');
    await writeFile(path, line(600) + line(700));
    const page = await store.read(path, 'message-700');
    expect(page.records.map((record) => record.uuid)).toEqual(['message-600']);
    expect(page.hasEarlier).toBe(false);
    await rm(path);
    await writeFile(path, line(650) + line(700));
    expect((await store.read(path, 'message-700')).records[0].uuid).toBe(
      'message-650',
    );
  });
  it('serves concurrent readers even when their entries exceed cache capacity', async () => {
    const paths = Array.from({ length: 32 }, (_, i) =>
      join(root, `agent-${i}.jsonl`),
    );
    await Promise.all(paths.map((file, i) => writeFile(file, line(i))));
    const store = new ClaudeChildTranscriptStore();
    const pages = await Promise.all(paths.map((file) => store.read(file)));
    expect(pages.map((page) => page.records[0].uuid)).toEqual(
      paths.map((_, i) => `message-${i}`),
    );
    expect((await store.read(paths[0])).records[0].uuid).toBe('message-0');
  });
});
