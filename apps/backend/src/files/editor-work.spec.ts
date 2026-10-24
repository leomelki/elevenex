import * as path from 'node:path';
import {
  prepareSearchCandidates,
  rankSearchCandidates,
  FilesService,
} from './files.service';
import { EditorWorkQueue } from './editor-work';

function legacy(paths: string[], query: string, limit: number) {
  return paths
    .map((relative) => {
      const lower = relative.toLowerCase();
      const name = path.posix.basename(relative);
      const basename = name.toLowerCase();
      let cursor = 0;
      for (const char of lower) if (char === query[cursor]) cursor++;
      const rank =
        !query || basename.startsWith(query)
          ? 0
          : basename.includes(query)
            ? 1
            : lower.includes(query)
              ? 2
              : cursor === query.length
                ? 3
                : null;
      return { path: relative, name, rank };
    })
    .filter((item) => item.rank !== null)
    .sort(
      (a, b) =>
        a.rank! - b.rank! ||
        (a.name.toLowerCase() !== b.name.toLowerCase()
          ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          : a.path.localeCompare(b.path)),
    )
    .slice(0, limit)
    .map(({ path, name }) => ({ path, name }));
}

describe('cooperative editor work', () => {
  it('preserves ranking and all four match buckets on 100k candidates', async () => {
    const paths = Array.from(
      { length: 100_000 },
      (_, i) =>
        `${i % 2 ? 'Component' : 'lib'}/module-${i % 700}/test-file-${(i * 7919) % 100_000}.TS`,
    );
    paths.push(
      'file-exact.ts',
      'lib/prefix-file.ts',
      'file/path/match.ts',
      'fuzzy/i/l/e.ts',
      'École.ts',
      'école.ts',
    );
    const candidates = await prepareSearchCandidates(paths);
    for (const query of [
      '',
      'test',
      'file',
      'component/module-2',
      'é',
      'fuzzyie',
      'absent',
    ]) {
      expect(
        await rankSearchCandidates(
          candidates,
          query,
          100,
          new AbortController().signal,
        ),
      ).toEqual(legacy(paths, query, 100));
    }
  });
  it('cancels CPU work between slices instead of finishing a synchronous scan', async () => {
    const candidates = await prepareSearchCandidates(
      Array.from({ length: 100_000 }, (_, i) => `file-${i}.ts`),
    );
    const controller = new AbortController();
    const query = rankSearchCandidates(
      candidates,
      'zzzzz',
      100,
      controller.signal,
    );
    controller.abort(new Error('superseded'));
    await expect(query).rejects.toThrow('superseded');
    const build = prepareSearchCandidates(
      Array.from({ length: 100_000 }, (_, i) => `file-${i}.ts`),
      controller.signal,
    );
    await expect(build).rejects.toThrow('superseded');
  });
  it('bounds waiting work and removes cancelled queued tasks', async () => {
    const queue = new EditorWorkQueue(1, 1);
    let release!: () => void;
    const first = queue.run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const work = jest.fn(async () => undefined);
    const second = queue.run(controller.signal, work);
    await expect(queue.run(new AbortController().signal, work)).rejects.toThrow(
      'busy',
    );
    controller.abort(new Error('superseded'));
    await expect(second).rejects.toThrow('superseded');
    release();
    await first;
    expect(work).not.toHaveBeenCalled();
    expect((queue as any).active).toBe(0);
    expect((queue as any).pending).toHaveLength(0);
  });
  it('leaves a shared candidate refresh alive when one query is cancelled', async () => {
    const service = new FilesService();
    let finish!: (paths: any[]) => void;
    const refresh = new Promise<any[]>((resolve) => {
      finish = resolve;
    });
    const loader = jest
      .spyOn(service as any, 'listSearchCandidatePaths')
      .mockReturnValue(refresh);
    const firstAbort = new AbortController();
    const first = service.searchFiles('/tmp', 'file', 100, firstAbort.signal);
    const second = service.searchFiles('/tmp', 'file', 100);
    const rejected = expect(first).rejects.toThrow();
    firstAbort.abort();
    await rejected;
    finish(await prepareSearchCandidates(['file.ts']));
    await expect(second).resolves.toEqual([
      { path: 'file.ts', name: 'file.ts' },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
