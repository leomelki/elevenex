import type { BrowserContext, Frame, Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';

jest.setTimeout(60000);
const wait = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};
const move = {
  kind: 'pointer-relative' as const,
  deltaX: 3,
  deltaY: -2,
  buttons: 0,
  modifiers: 0,
};
interface Trace {
  x: number;
  y: number;
  trusted: boolean;
  buttonMasks: number[];
  keys: { key: string; type: string; x: number }[];
}

describe('pointer lock through public runtime input', () => {
  let root: string, previous: string | undefined, server: Server, url: string;
  let pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask,
    context: BrowserContext,
    page: Page,
    tabId: string;
  let began: () => void;
  const snapshot = () => task.page(tabId).snapshot();
  const input = (event: Parameters<RuntimeBrowserTask['input']>[2]) =>
    task.input(tabId, snapshot().generation, event);
  const trace = (frame: Frame = page.mainFrame()) =>
    frame.evaluate<Trace>('window.trace');
  const lock = async (frame: Frame = page.mainFrame()) => {
    const rect = await frame.locator('#lock').boundingBox();
    if (!rect) throw new Error('Missing lock control');
    const x = rect.x + 10,
      y = rect.y + 10;
    await input({
      kind: 'batch',
      events: [
        {
          kind: 'pointer',
          type: 'move',
          x,
          y,
          button: 'none',
          buttons: 0,
          clicks: 0,
          modifiers: 0,
        },
        {
          kind: 'pointer',
          type: 'down',
          x,
          y,
          button: 'left',
          buttons: 1,
          clicks: 1,
          modifiers: 0,
        },
        {
          kind: 'pointer',
          type: 'up',
          x,
          y,
          button: 'left',
          buttons: 0,
          clicks: 1,
          modifiers: 0,
        },
      ],
    });
    try {
      await wait(() => snapshot().pointerLocked === true);
    } catch (error) {
      throw new Error(
        'Lock not acquired: ' +
          JSON.stringify({
            state: snapshot(),
            native: await frame.evaluate(
              '({locked:!!document.pointerLockElement,error:window.lockError,focused:document.hasFocus()})',
            ),
          }),
        { cause: error },
      );
    }
    return snapshot().pointerLockEpoch!;
  };
  const busy = async (frame: Frame, ms: number) => {
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const finished = frame.evaluate((ms) => {
      const notify: unknown = Reflect.get(globalThis, '__fixtureBusyStarted');
      if (typeof notify !== 'function') throw new Error('Missing busy fixture');
      Reflect.apply(notify, globalThis, []);
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* Deliberately block this renderer. */
      }
    }, ms);
    await started;
    return { finished };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-pointer-lock-'));
    previous = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = root;
    server = createServer((req, res) => {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing server');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Pointer fixture</title><button id="lock" style="position:absolute;left:20px;top:20px;width:120px;height:60px">Lock</button>
        ${req.url?.startsWith('/frame') ? '' : `<iframe src="http://localhost:${address.port}/frame" style="position:absolute;left:500px;top:200px;width:250px;height:250px"></iframe>`}
        <script>window.trace={x:0,y:0,trusted:true,keys:[],buttonMasks:[]};
        document.querySelector('#lock').onclick=()=>document.body.requestPointerLock().catch(error=>window.lockError=error.name+': '+error.message);
        document.addEventListener('mousemove',e=>{if(document.pointerLockElement){trace.x+=e.movementX;trace.y+=e.movementY;trace.trusted&&=e.isTrusted;trace.buttonMasks.push(e.buttons)}});
        for(const type of ['keydown','keyup'])document.addEventListener(type,e=>trace.keys.push({key:e.key,type:e.type,x:trace.x}));</script>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    url = 'http://127.0.0.1:' + address.port;
    pool = new RuntimeBrowserPool();
    const acquire = pool.acquire.bind(pool);
    jest.spyOn(pool, 'acquire').mockImplementation(async (...args) => {
      context = await acquire(...args);
      return context;
    });
    task = new RuntimeBrowserTask(1, pool, 'c'.repeat(64));
    task.setPorts([address.port]);
    const tab = await task.create('you', null, url);
    tabId = tab.id;
    page = context
      .pages()
      .find((candidate) => candidate.url().startsWith(url))!;
  });
  beforeEach(async () => {
    // Lock request throttling belongs to Chromium's Page. Isolate cases with
    // fresh tabs instead of disabling the browser's real abuse protection.
    await task.command({ kind: 'close', tabId });
    const tab = await task.create('you', null, url);
    tabId = tab.id;
    page = context
      .pages()
      .find((candidate) => candidate.url().startsWith(url))!;
    await page.exposeBinding('__fixtureBusyStarted', () => began());
    await task.layout(800, 600, true, true);
    await page.waitForLoadState('load');
  });
  afterAll(async () => {
    await task?.destroy();
    await pool?.onModuleDestroy();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(root, { recursive: true, force: true });
  });

  it('delivers before unrelated cross-process JavaScript finishes, preserving trusted deltas', async () => {
    const stray = await context.newPage(),
      closed = stray.waitForEvent('close');
    task.sweep();
    await closed;
    expect(
      context.pages().filter((page) => pool.isWindowAnchor(page)),
    ).toHaveLength(process.platform === 'darwin' ? 1 : 0);
    await task.command({ kind: 'dismiss-attention' });
    const pointerLockEpoch = await lock();
    const child = page.frames().find((frame) => frame !== page.mainFrame())!;
    const childSession = await context.newCDPSession(child); // Require a genuine OOPIF.
    await childSession.detach();
    const { finished } = await busy(child, 500);
    const delivered = input({ ...move, pointerLockEpoch });
    const first = await Promise.race([
      finished.then(() => 'unrelated frame'),
      delivered.then(() => 'input'),
    ]);
    await Promise.all([finished, delivered]);
    expect(first).toBe('input');
    expect(await trace()).toMatchObject({ x: 3, y: -2, trusted: true });
    await input({ ...move, deltaX: -1400, deltaY: -800, pointerLockEpoch });
    await input({ ...move, deltaX: 1300, deltaY: 600, pointerLockEpoch });
    expect(await trace()).toMatchObject({ x: -97, y: -202, trusted: true });
  });

  // Chromium's CDP handler hit-tests accumulated positions even under lock.
  // Keep the desired native behavior visible until the engine can route it
  // directly to the owner. A fixed engine makes this expected failure fail.
  it.failing(
    'delivers movement to the locked owner when virtual coordinates cross a cross-process iframe',
    async () => {
      const pointerLockEpoch = await lock();
      await input({ ...move, deltaX: 520, deltaY: 220, pointerLockEpoch });
      expect(await trace()).toMatchObject({ x: 520, y: 220, trusted: true });
    },
  );

  it('preserves all motion across a pipelined window, modifiers, keys and complete batch barriers', async () => {
    const pointerLockEpoch = await lock();
    const writes = Array.from({ length: 4 }, () =>
      input({ ...move, pointerLockEpoch }),
    );
    writes.push(
      input({
        kind: 'key',
        type: 'down',
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        modifiers: 8,
      }),
    );
    writes.push(
      input({
        kind: 'batch',
        events: [
          { ...move, deltaX: -2, deltaY: 1, modifiers: 8, pointerLockEpoch },
          { ...move, deltaX: -2, deltaY: 1, modifiers: 8, pointerLockEpoch },
          {
            kind: 'key',
            type: 'up',
            key: 'Shift',
            code: 'ShiftLeft',
            keyCode: 16,
            modifiers: 0,
          },
        ],
      }),
    );
    await Promise.all(writes);
    expect(await trace()).toMatchObject({
      x: 8,
      y: -6,
      trusted: true,
      keys: [
        { key: 'Shift', type: 'keydown', x: 12 },
        { key: 'Shift', type: 'keyup', x: 8 },
      ],
    });
  });

  it('rejects an old acquisition and ignores a late unlock without breaking legacy input', async () => {
    const old = await lock();
    await page.evaluate(() => document.exitPointerLock());
    await wait(() => !snapshot().pointerLocked);
    const current = await lock();
    expect(current).toBeGreaterThan(old);
    await expect(input({ ...move, pointerLockEpoch: old })).rejects.toThrow(
      'Pointer lock ended',
    );
    await input({ kind: 'pointer-unlock', pointerLockEpoch: old });
    expect(snapshot().pointerLockEpoch).toBe(current);
    expect(snapshot().pointerLocked).toBe(true);
    await input(move);
    expect(await trace()).toMatchObject({ x: 3, y: -2 });
  });

  it('preserves held buttons across pipelined camera movement and drains before mouse-up', async () => {
    const pointerLockEpoch = await lock();
    const pointer = {
      kind: 'pointer' as const,
      x: 30,
      y: 30,
      button: 'left' as const,
      clicks: 1,
      modifiers: 0,
    };
    await input({ ...pointer, type: 'down', buttons: 1 });
    const writes = Array.from({ length: 4 }, () =>
      input({ ...move, buttons: 1, pointerLockEpoch }),
    );
    writes.push(input({ ...pointer, type: 'up', buttons: 0 }));
    await Promise.all(writes);
    const delivered = await trace();
    expect(delivered).toMatchObject({ x: 12, y: -8, trusted: true });
    expect(delivered.buttonMasks.every((buttons) => buttons === 1)).toBe(true);
  });

  it('revokes admission immediately while native movement receipts are stalled', async () => {
    const pointerLockEpoch = await lock();
    const { finished } = await busy(page.mainFrame(), 500);
    const writes = Array.from({ length: 4 }, () =>
      input({ ...move, pointerLockEpoch }).catch(() => undefined),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const released = input({ kind: 'pointer-unlock', pointerLockEpoch });
    expect(snapshot().pointerLocked).toBe(false);
    expect(
      await Promise.race([
        released.then(() => 'revoked'),
        finished.then(() => 'page finished'),
      ]),
    ).toBe('revoked');
    await Promise.all([...writes, finished, released]);
    await wait(() => !snapshot().pointerLocked);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  });

  it('observes cross-process iframe ownership and revokes it when that frame is removed', async () => {
    const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
    const pointerLockEpoch = await lock(frame);
    await input({ ...move, pointerLockEpoch });
    expect(await trace(frame)).toMatchObject({ x: 3, y: -2, trusted: true });
    await page.evaluate(() => document.querySelector('iframe')!.remove());
    await wait(() => !snapshot().pointerLocked);
    await expect(input({ ...move, pointerLockEpoch })).rejects.toThrow(
      'Pointer lock ended',
    );
  });

  it('reinstalls observation across cross-process and local iframe navigation', async () => {
    let frame = page.frames().find((frame) => frame !== page.mainFrame())!;
    let previous = await lock(frame);
    for (const destination of [
      url + '/frame',
      url.replace('127.0.0.1', 'localhost') + '/frame',
    ]) {
      await page.evaluate((destination) => {
        document.querySelector('iframe')!.src = destination;
      }, destination);
      await wait(
        () =>
          !snapshot().pointerLocked &&
          page.frames().some((candidate) => candidate.url() === destination),
      );
      frame = page
        .frames()
        .find((candidate) => candidate.url() === destination)!;
      await frame.waitForLoadState('load');
      const pointerLockEpoch = await lock(frame);
      expect(pointerLockEpoch).toBeGreaterThan(previous);
      await expect(
        input({ ...move, pointerLockEpoch: previous }),
      ).rejects.toThrow('Pointer lock ended');
      await input({ ...move, pointerLockEpoch });
      expect(await trace(frame)).toMatchObject({ x: 3, y: -2 });
      previous = pointerLockEpoch;
    }
  });

  it('invalidates the lease when release/reacquisition completes before change events are serviced', async () => {
    const old = await lock();
    await page.evaluate(async () => {
      document.exitPointerLock();
      await document.body.requestPointerLock();
    });
    await wait(
      () =>
        snapshot().pointerLocked === true && snapshot().pointerLockEpoch! > old,
    );
    expect(snapshot().pointerLocked).toBe(true);
    await expect(input({ ...move, pointerLockEpoch: old })).rejects.toThrow(
      'Pointer lock ended',
    );
  });

  it('keeps observation private and rejects main-world getter and synthetic-event spoofing', async () => {
    expect(
      await page.evaluate(() =>
        Object.keys(globalThis).filter((key) =>
          key.startsWith('__elevenexPointerLock'),
        ),
      ),
    ).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'pointerLockElement', {
        configurable: true,
        get: () => document.body,
      });
      document.dispatchEvent(new Event('pointerlockchange'));
    });
    await expect(input(move)).rejects.toThrow('Pointer lock ended');
    expect(snapshot().pointerLocked).toBe(false);
  });

  it('recovers observation after document.open replaces listeners without navigation', async () => {
    const old = await lock();
    const previous = snapshot();
    await page.evaluate(() => {
      document.open();
      document.write(`<!doctype html><button id="lock" style="position:absolute;left:20px;top:20px;width:120px;height:60px" onclick="document.body.requestPointerLock().catch(error=>window.lockError=error.message)">Lock</button>
        <script>window.trace={x:0,y:0,trusted:true,keys:[],buttonMasks:[]};document.addEventListener('mousemove',e=>{if(document.pointerLockElement){trace.x+=e.movementX;trace.y+=e.movementY;trace.trusted&&=e.isTrusted}})</script>`);
      document.close();
    });
    await wait(() => !snapshot().pointerLocked);
    expect(snapshot().displayEpoch).toBeGreaterThan(previous.displayEpoch!);
    await expect(task.input(tabId, previous.generation, move)).rejects.toThrow(
      'Browser control changed',
    );
    // A real viewer waits for a frame of the replacement document before
    // enabling input; do not click while its native lifecycle is still opening.
    await task.page(tabId).nextFrame(0, new AbortController().signal);
    const pointerLockEpoch = await lock();
    expect(pointerLockEpoch).toBeGreaterThan(old);
    await expect(input({ ...move, pointerLockEpoch: old })).rejects.toThrow(
      'Pointer lock ended',
    );
    await input({ ...move, pointerLockEpoch });
    expect(await trace()).toMatchObject({ x: 3, y: -2 });
  });

  it('expires a stalled owner once, then permits a fresh acquisition after recovery', async () => {
    const old = await lock();
    const { finished } = await busy(page.mainFrame(), 1800);
    const cleared = wait(() => !snapshot().pointerLocked);
    const first = await Promise.race([
      finished.then(() => 'page recovered'),
      cleared.then(() => 'revoked'),
    ]);
    await Promise.all([finished, cleared]);
    expect(first).toBe('revoked');
    await page.waitForFunction(() => document.pointerLockElement === null);
    expect(await lock()).toBeGreaterThan(old);
  });

  it('closes a stalled renderer during engine reset without waiting for JavaScript or input receipts', async () => {
    const pointerLockEpoch = await lock();
    const { finished } = await busy(page.mainFrame(), 1500);
    const cancelled = expect(finished).rejects.toThrow();
    const delivered = input({ ...move, pointerLockEpoch }).catch(
      () => undefined,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await task.page(tabId).resetEngine();
    await Promise.all([cancelled, delivered]);
    expect(page.isClosed()).toBe(true);
    expect(snapshot().pointerLocked).toBe(false);
  });
});
