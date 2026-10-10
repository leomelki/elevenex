import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptFileCache } from './transcript-file-cache.js';

describe('TranscriptFileCache', () => {
  let root: string;
  let path: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'transcript-cache-'));
    path = join(root, 'transcript.jsonl');
    await writeFile(path, '{"text":"first"}');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reuses unchanged files and isolates nested caller mutations', async () => {
    const cache = new TranscriptFileCache<{ text: string }>();
    const load = jest.fn(async () => JSON.parse(await readFile(path, 'utf8')));
    const first = await cache.read(path, load);
    first.text = 'mutated';
    expect(await cache.read(path, load)).toEqual({ text: 'first' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads appended, truncated and replaced transcripts', async () => {
    const cache = new TranscriptFileCache<string>();
    const load = () => readFile(path, 'utf8');
    await cache.read(path, load);
    await appendFile(path, '\nnext');
    expect(await cache.read(path, load)).toContain('next');
    await writeFile(path, 'rewound');
    expect(await cache.read(path, load)).toBe('rewound');
    const replacement = join(root, 'replacement');
    await writeFile(replacement, 'changed');
    await rename(replacement, path);
    expect(await cache.read(path, load)).toBe('changed');
  });

  it('coalesces concurrent reads of the same revision', async () => {
    const cache = new TranscriptFileCache<string>();
    let release!: (value: string) => void;
    const load = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const first = cache.read(path, load);
    const second = cache.read(path, load);
    // Let both asynchronous stat calls finish while the loader remains blocked.
    while (!load.mock.calls.length) await new Promise(setImmediate);
    await new Promise(setImmediate);
    release('snapshot');
    expect(await Promise.all([first, second])).toEqual([
      'snapshot',
      'snapshot',
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not retain snapshots read during a file change or failed loads', async () => {
    const cache = new TranscriptFileCache<string>();
    await cache.read(path, async () => {
      await appendFile(path, '\nnew');
      return 'old';
    });
    const fresh = jest.fn(() => readFile(path, 'utf8'));
    expect(await cache.read(path, fresh)).toContain('new');
    expect(fresh).toHaveBeenCalledTimes(1);
    await writeFile(path, 'another revision');
    await expect(
      cache.read(path, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await cache.read(path, fresh)).toBe('another revision');
  });

  it('evicts least recently used files and does not retain oversized files', async () => {
    const cache = new TranscriptFileCache<string>(64, 1);
    const load = jest.fn(() => readFile(path, 'utf8'));
    await cache.read(path, load);
    const other = join(root, 'other');
    await writeFile(other, 'other');
    await cache.read(other, () => readFile(other, 'utf8'));
    await cache.read(path, load);
    expect(load).toHaveBeenCalledTimes(2);
    await writeFile(path, 'x'.repeat(65));
    await cache.read(path, load);
    await cache.read(path, load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
