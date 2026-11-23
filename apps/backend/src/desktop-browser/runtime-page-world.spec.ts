import type { CDPSession } from 'patchright-core';
import { RuntimePageWorld } from './runtime-page-world.js';

function fixture() {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  let worlds = 0;
  let staleOnce = false;
  const page = { url: 'https://site.test/', title: 'Home' };
  const send = jest.fn(
    (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Page.getFrameTree')
        return Promise.resolve({ frameTree: { frame: { id: 'main' } } });
      if (method === 'Page.createIsolatedWorld')
        return Promise.resolve({ executionContextId: ++worlds });
      if (method === 'Runtime.evaluate') {
        if (staleOnce) {
          staleOnce = false;
          return Promise.reject(
            new Error('Cannot find context with specified id'),
          );
        }
        const expression = String(params?.['expression']);
        return Promise.resolve({
          result: {
            value: expression.includes('document.title')
              ? { ...page }
              : 'pointer',
          },
        });
      }
      return Promise.resolve({});
    },
  );
  // Only the CDP session boundary belongs to the page world.
  const cdp = {
    send,
    on: (event: string, listener: (params: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event: string, listener: (params: unknown) => void) =>
      listeners.get(event)?.delete(listener),
  } as unknown as CDPSession;
  const emit = (event: string, params: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(params);
  };
  const titles: [string, string][] = [];
  const world = new RuntimePageWorld(cdp, (url, title) =>
    titles.push([url, title]),
  );
  const methods = () => send.mock.calls.map(([method]) => method);
  const contexts = () =>
    send.mock.calls
      .filter(([method]) => method === 'Runtime.evaluate')
      .map(([, params]) => params?.['contextId']);
  return {
    world,
    emit,
    page,
    titles,
    methods,
    contexts,
    listeners,
    stale: () => (staleOnce = true),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('never enables Runtime or Console and reuses one private world per document', async () => {
  const f = fixture();
  try {
    await f.world.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(await f.world.evaluate('cursor')).toBe('pointer');
    expect(await f.world.evaluate('cursor')).toBe('pointer');
    // A subframe navigation keeps the top-level document's world.
    f.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } });
    expect(await f.world.evaluate('cursor')).toBe('pointer');
    expect(
      f.methods().filter((method) => method === 'Page.createIsolatedWorld'),
    ).toHaveLength(1);
    f.emit('Page.frameNavigated', { frame: { id: 'main' } });
    await jest.advanceTimersByTimeAsync(0);
    expect(await f.world.evaluate('cursor')).toBe('pointer');
    expect(
      f.methods().filter((method) => method === 'Page.createIsolatedWorld'),
    ).toHaveLength(2);
    expect(f.contexts().at(-1)).toBe(2);
    expect(f.methods()).not.toEqual(
      expect.arrayContaining([
        'Runtime.enable',
        'Console.enable',
        'Runtime.addBinding',
      ]),
    );
  } finally {
    f.world.destroy();
  }
});

it('retries once when a navigation retired the cached context', async () => {
  const f = fixture();
  try {
    await f.world.start();
    await jest.advanceTimersByTimeAsync(0);
    f.stale();
    expect(await f.world.evaluate('cursor')).toBe('pointer');
    expect(f.contexts().slice(-2)).toEqual([1, 2]);
  } finally {
    f.world.destroy();
  }
});

it('publishes each title change once and stops sampling when destroyed', async () => {
  const f = fixture();
  await f.world.start();
  await jest.advanceTimersByTimeAsync(3000);
  expect(f.titles).toEqual([['https://site.test/', 'Home']]);
  f.page.title = 'Inbox (3)';
  await jest.advanceTimersByTimeAsync(1000);
  f.emit('Page.navigatedWithinDocument', {
    frameId: 'main',
    url: 'https://site.test/#a',
  });
  f.page.url = 'https://site.test/#a';
  await jest.advanceTimersByTimeAsync(1000);
  expect(f.titles).toEqual([
    ['https://site.test/', 'Home'],
    ['https://site.test/', 'Inbox (3)'],
    ['https://site.test/#a', 'Inbox (3)'],
  ]);
  f.world.destroy();
  const sent = f.methods().length;
  await jest.advanceTimersByTimeAsync(5000);
  expect(f.methods()).toHaveLength(sent);
  expect(jest.getTimerCount()).toBe(0);
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
  await expect(f.world.evaluate('cursor')).rejects.toThrow(
    'Page is unavailable',
  );
});

it('samples the title shortly after interaction, coalescing bursts', async () => {
  const f = fixture();
  try {
    await f.world.start();
    await jest.advanceTimersByTimeAsync(0);
    const reads = () => f.contexts().length;
    const before = reads();
    f.page.title = 'Saved';
    for (let n = 0; n < 5; n++) f.world.titleMayChange();
    await jest.advanceTimersByTimeAsync(100);
    expect(reads()).toBe(before + 1);
    expect(f.titles.at(-1)).toEqual(['https://site.test/', 'Saved']);
  } finally {
    f.world.destroy();
  }
});
