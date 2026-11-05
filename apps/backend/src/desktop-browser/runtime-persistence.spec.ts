import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeBrowserPersistence } from './runtime-persistence.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import { runtimeCommand } from './runtime-validation.js';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
describe('Runtime browser retention and viewer authority', () => {
  let root: string,
    previous: string | undefined,
    store: RuntimeBrowserPersistence;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'browser-state-'));
    previous = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = root;
    store = new RuntimeBrowserPersistence();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
  });
  it('opens and selects bounded start tabs without starting Chromium', async () => {
    expect(runtimeCommand.parse({ kind: 'new-tab' })).toEqual({
      kind: 'new-tab',
    });
    expect(
      runtimeCommand.safeParse({ kind: 'new-tab', url: 'file:///secret' })
        .success,
    ).toBe(false);
    const pool = new RuntimeBrowserPool();
    const acquire = jest.spyOn(pool, 'acquire');
    const service = new RuntimeBrowserService(pool, store);
    try {
      const view = await service.connect(1, 'viewer', 'c'.repeat(64));
      const task = service.viewer(1, view.token);
      const first = await task.command({ kind: 'new-tab' });
      expect(first.tabs).toHaveLength(1);
      expect(first.tabs[0]).toMatchObject({
        id: first.active,
        title: 'New tab',
        url: '',
        driver: 'you',
        loading: false,
      });
      await task.layout(800, 600, true, true);
      const second = await task.command({ kind: 'new-tab' });
      expect(second.active).not.toBe(first.active);
      await task.command({ kind: 'select', tabId: first.active! });
      await task.command({ kind: 'reload', tabId: first.active! });
      expect(task.state().active).toBe(first.active);
      expect(acquire).not.toHaveBeenCalled();
      for (let count = 2; count < 12; count++)
        await task.command({ kind: 'new-tab' });
      await expect(task.command({ kind: 'new-tab' })).rejects.toThrow(/limit/);
    } finally {
      await service.onModuleDestroy();
      await pool.onModuleDestroy();
    }
  });
  it('retains user ownership when an old agent launch fails after takeover', async () => {
    const pool = new RuntimeBrowserPool();
    let rejectStartup: (error: Error) => void = () => undefined;
    let markStarting: () => void = () => undefined;
    const starting = new Promise<void>(resolve => { markStarting = resolve; });
    jest.spyOn(pool, 'acquire').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStartup = reject;
          markStarting();
        }),
    );
    const service = new RuntimeBrowserService(pool, store);
    try {
      const view = await service.connect(1, 'viewer', 'b'.repeat(64));
      const task = service.viewer(1, view.token),
        controller = new AbortController();
      const opening = task.agent(
        { kind: 'open', url: 'https://example.com' },
        2,
        controller.signal,
      );
      void opening.catch(() => undefined);
      await starting;
      const tabId = task.state().tabs[0]!.id;
      await task.command({ kind: 'takeover', tabId });
      controller.abort();
      rejectStartup(new Error('Owned fixture startup interrupted'));
      await expect(opening).rejects.toThrow();
      expect(task.state().tabs).toHaveLength(1);
      expect(task.state().tabs[0]).toMatchObject({ id: tabId, driver: 'you' });
    } finally {
      await service.onModuleDestroy();
      await pool.onModuleDestroy();
    }
  });
  it('bounds saved locations and restores metadata with user control without starting Chromium', async () => {
    const identity = 'a'.repeat(64);
    expect(
      await store.save(identity, {
        active: 0,
        tabs: [
          {
            url: 'https://example.com/account?secret=private#code',
            width: 'phone',
            by: 'agent',
            agentSessionId: 2,
          },
        ],
      }),
    ).toBe(true);
    const saved = await store.read(identity);
    expect(saved?.tabs[0]?.url).toBe('https://example.com/account');
    const pool = {
      acquire: jest.fn(),
      isApplicationPort: () => false,
      reservePort: () => undefined,
    } as unknown as RuntimeBrowserPool;
    const service = new RuntimeBrowserService(pool, store);
    try {
      const view = await service.connect(1, 'first', identity);
      expect(view.state.tabs[0]).toMatchObject({
        driver: 'you',
        by: 'agent',
        width: 'phone',
      });
      expect(pool.acquire).not.toHaveBeenCalled();
      await expect(service.connect(1, 'second', identity)).rejects.toThrow(
        /active viewer/,
      );
      service.disconnect(1, view.token);
      const next = await service.connect(1, 'second', identity);
      expect(next.token).not.toBe(view.token);
      expect(() => service.viewer(1, view.token)).toThrow();
      expect(next.state.tabs[0]?.generation).toBe(
        view.state.tabs[0]!.generation,
      );
    } finally {
      await service.onModuleDestroy();
    }
  });
  it('does not restore another task incarnation and evicts only tasks without viewers', async () => {
    const pool = {
      acquire: jest.fn(),
      isApplicationPort: () => false,
      reservePort: () => undefined,
    } as unknown as RuntimeBrowserPool;
    const service = new RuntimeBrowserService(pool, store);
    try {
      const first = await service.connect(1, 'viewer', 'a'.repeat(64));
      service.viewer(1, first.token).restore({
        active: 0,
        tabs: [
          {
            url: 'https://example.com/private',
            width: 'full',
            by: 'you',
            agentSessionId: null,
          },
        ],
      });
      const replaced = await service.connect(1, 'viewer', 'b'.repeat(64));
      expect(replaced.state.tabs).toEqual([]);
      expect(() => service.viewer(1, first.token)).toThrow();
      for (let id = 2; id <= 4; id++)
        await service.connect(id, 'viewer', String(id).repeat(64));
      await expect(
        service.connect(5, 'viewer', '5'.repeat(64)),
      ).rejects.toThrow(/limit/);
      service.disconnect(1, replaced.token);
      expect(
        (await service.connect(5, 'viewer', '5'.repeat(64))).state.taskId,
      ).toBe(5);
    } finally {
      await service.onModuleDestroy();
    }
  });
  it('rejects forged identities and oversized files without exposing their content', async () => {
    await expect(store.read('../outside')).rejects.toThrow();
    expect(await store.save('../outside', { active: 0, tabs: [] })).toBe(false);
    await store.save('c'.repeat(64), { active: 0, tabs: [] });
    await writeFile(
      join(root, 'task-browser-state', 'c'.repeat(64) + '.json'),
      'x'.repeat(40000),
    );
    expect(await store.read('c'.repeat(64))).toBeNull();
  });
});
