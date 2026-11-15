import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { BinaryPathResolver } from './binary-paths.js';

describe('asynchronous executable discovery', () => {
  let path: string;
  let executables: Set<string>;
  let resolver: BinaryPathResolver;
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    path = '/first:/second';
    executables = new Set(['/first/codex', '/second/codex']);
    resolver = new BinaryPathResolver(
      () => ({ path, extensions: undefined }),
      false,
    );
    jest
      .spyOn(jest.requireActual<typeof promises>('node:fs/promises'), 'access')
      .mockImplementation((candidate) =>
        executables.has(String(candidate))
          ? Promise.resolve()
          : Promise.reject(new Error('missing')),
      );
    jest
      .spyOn(jest.requireActual<typeof fs>('node:fs'), 'accessSync')
      .mockImplementation(() => {
        throw new Error('No sync filesystem access expected');
      });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it('coalesces concurrent discovery and serves warm reads without additional filesystem work', async () => {
    const paths = await Promise.all(
      Array.from({ length: 1000 }, () => resolver.findAsync('codex')),
    );
    expect(new Set(paths)).toEqual(new Set(['/first/codex']));
    expect(promises.access).toHaveBeenCalledTimes(1);
    expect(resolver.find('codex')).toBe('/first/codex');
    expect(fs.accessSync).not.toHaveBeenCalled();
  });

  it('bounds outstanding filesystem lookups during a burst of distinct commands', async () => {
    const completions: (() => void)[] = [];
    jest.mocked(promises.access).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve);
        }),
    );
    const results = Array.from({ length: 256 }, (_, index) =>
      resolver.findAsync(`tool-${index}`).then(
        () => true,
        () => false,
      ),
    );
    expect(completions).toHaveLength(128);
    for (const complete of completions) complete();
    expect((await Promise.all(results)).filter(Boolean)).toHaveLength(128);
  });
  it('adopts a new PATH and removed binaries after the short validation interval', async () => {
    expect(await resolver.findAsync('codex')).toBe('/first/codex');
    path = '/second:/first';
    expect(await resolver.findAsync('codex')).toBe('/second/codex');
    executables.delete('/second/codex');
    jest.advanceTimersByTime(1000);
    expect(await resolver.findAsync('codex')).toBe('/first/codex');
  });
  it('retries missing tools without a negative lookup cache', async () => {
    expect(await resolver.findAsync('new-cli')).toBeNull();
    executables.add('/first/new-cli');
    expect(await resolver.findAsync('new-cli')).toBe('/first/new-cli');
  });
  it('does not let an older lookup repopulate the cache after invalidation', async () => {
    let finish!: () => void;
    jest.mocked(promises.access).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const old = resolver.findAsync('codex');
    resolver.clear();
    executables.delete('/first/codex');
    expect(await resolver.findAsync('codex')).toBe('/second/codex');
    finish();
    await old;
    expect(await resolver.findAsync('codex')).toBe('/second/codex');
  });
});
