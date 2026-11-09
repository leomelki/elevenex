import type { BrowserContext, Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { RuntimeBrowserInput } from './runtime-input.js';

jest.setTimeout(90000);
describe('remote browser interaction and display ownership', () => {
  let directory: string,
    previous: string | undefined,
    server: Server,
    url: string;
  let pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask,
    page: Page,
    context: BrowserContext;
  let tabId: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elevenex-browser-interaction-'));
    previous = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = directory;
    server = createServer((_request, response) => {
      if (_request.url === '/source.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('compiled\n//# sourceMappingURL=/source.js.map');
        return;
      }
      if (_request.url === '/source.js.map') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ version: 3, sources: ['src/Checkout.tsx'], names: [], mappings: 'AAuFA' }));
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<!doctype html><input id="field">
        <style>#hover{position:absolute;left:300px;top:100px;width:200px;height:100px;background:rgb(20,40,200);border:0}#hover:hover{background:rgb(20,200,40)}</style>
        <button id="hover" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Hover and click</button>
        <script>window.documentIdentity=crypto.randomUUID()</script>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture listener unavailable');
    url = `http://127.0.0.1:${address.port}`;
    pool = new RuntimeBrowserPool();
    const acquire = pool.acquire.bind(pool);
    const launch = jest
      .spyOn(pool, 'acquire')
      .mockImplementation(async (...args) => {
        context = await acquire(...args);
        return context;
      });
    task = new RuntimeBrowserTask(1, pool, 'e'.repeat(64));
    const tab = await task.create('you', null, url);
    tabId = tab.id;
    launch.mockRestore();
    const opened = context
      .pages()
      .find((candidate) => candidate.url().startsWith(url));
    if (!opened) throw new Error('Task page unavailable');
    page = opened;
    await task.layout(800, 600, true, true);
  });
  afterAll(async () => {
    await task?.destroy();
    await pool?.onModuleDestroy();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(directory, { recursive: true, force: true });
  });

  it('highlights and scrolls in point mode without activating the page, then clears on exit/cancel', async () => {
    const tab = task.page(tabId);
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Picker feedback did not settle');
    };
    await task.command({ kind: 'pick', enabled: true, visual: 1 });
    try {
      await task.input(tabId, tab.generation, { kind: 'pointer', type: 'move', x: 350, y: 150, button: 'none', buttons: 0, clicks: 0, modifiers: 0 });
      await waitFor(() => tab.snapshot().hovered?.tag === 'button');
      expect(tab.snapshot().hovered).toEqual({ tag: 'button', x: 300, y: 100, width: 200, height: 100 });
      await task.input(tabId, tab.generation, { kind: 'pointer', type: 'up', x: 350, y: 150, button: 'left', buttons: 0, clicks: 1, modifiers: 0 });
      expect(await page.locator('#hover').getAttribute('data-clicks')).toBeNull();
      await page.evaluate(() => document.body.style.height = '2000px');
      await task.input(tabId, tab.generation, { kind: 'wheel', x: 350, y: 150, deltaX: 0, deltaY: 80, modifiers: 0 });
      await waitFor(() => page.evaluate(() => scrollY > 0));
      await waitFor(() => tab.snapshot().hovered?.tag === 'body');
      expect(tab.picking).toBe(true);
      await task.input(tabId, tab.generation, { kind: 'pointer-exit' });
      expect(tab.snapshot().hovered).toBeUndefined();
      await task.command({ kind: 'pick', enabled: false });
      expect(tab.snapshot().hovered).toBeUndefined();
    } finally {
      await task.command({ kind: 'pick', enabled: false });
      await page.evaluate(() => { document.body.style.height = ''; scrollTo(0, 0); });
    }
  });

  it('captures every first click with real pixels without activating the target', async () => {
    const tab = task.page(tabId), timings: number[] = [];
    for (let i = 0; i < 6; i++) {
      await task.command({ kind: 'pick', enabled: true, visual: 1 });
      const start = performance.now();
      await task.input(tabId, tab.generation, { kind: 'pointer', type: 'down', x: 350, y: 150, button: 'left', buttons: 1, clicks: 1, modifiers: 0 });
      timings.push(Math.round(performance.now() - start));
      const selected = task.state().picked;
      expect(selected?.snapshot?.jpeg).toBeTruthy();
      expect(selected?.tag).toBe('button');
      expect(await page.locator('#hover').getAttribute('data-clicks')).toBeNull();
      await task.command({ kind: 'pick', enabled: false });
    }
    console.log('Remote-runtime first-click capture latency (ms):', timings);
  });

  it('keeps a failed visual capture ready for the next click without interrupting input', async () => {
    const tab = task.page(tabId), original = tab.agentTarget.bind(tab);
    const fault = jest.spyOn(tab, 'agentTarget').mockImplementation(async (...args) => {
      const target = await original(...args);
      return { ...target, send: (method, params, child) => method === 'Page.captureScreenshot' ? Promise.reject(new Error('Temporary capture failure')) : target.send(method, params, child) };
    });
    try {
      await task.command({ kind: 'pick', enabled: true, visual: 1 });
      const click = { kind: 'pointer' as const, type: 'down' as const, x: 350, y: 150, button: 'left' as const, buttons: 1, clicks: 1, modifiers: 0 };
      await task.input(tabId, tab.generation, click);
      expect(task.state().picked).toBeNull();
      expect(task.state().picking).toBe(true);
      expect(task.state().capturePending).toBe(false);
      fault.mockRestore();
      await task.input(tabId, tab.generation, click);
      expect(task.state().picked?.snapshot?.jpeg).toBeTruthy();
    } finally { fault.mockRestore(); await task.command({ kind: 'pick', enabled: false }); }
  });

  it('reloads fragment locations and produces frames for the current document epoch', async () => {
    await page.evaluate(() => history.replaceState(null, '', '#anchor'));
    const identity = await page.evaluate('window.documentIdentity');
    await task.command({ kind: 'reload', tabId });
    expect(await page.evaluate('window.documentIdentity')).not.toBe(identity);
    const tab = task.page(tabId),
      signal = new AbortController().signal;
    const first = await tab.nextFrame(0, signal, 5000, true);
    expect(first?.displayEpoch).toBe(tab.displayEpoch);
    await task.command({ kind: 'navigate', tabId, url: url + '/second' });
    const next = await tab.nextFrame(0, signal, 5000, true);
    expect(next).not.toBeNull();
    expect(next?.displayEpoch).toBe(tab.displayEpoch);
    expect(next!.displayEpoch).toBeGreaterThan(first!.displayEpoch!);
    expect(next!.sequence).toBeGreaterThan(first!.sequence);
  });

  it('resolves source maps only for an explicit human pick, across the remote state boundary', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document.querySelector('#hover'), '__reactFiber$test', { configurable: true, enumerable: true, value: {
        _debugStack: Object.assign(new Error(), { stack: 'Error\n at Checkout (' + location.origin + '/source.js:1:1)' }),
      } });
    });
    const tab = task.page(tabId);
    try {
      expect((await tab.inspect(350, 150))?.source).toBeUndefined();
      expect((await tab.inspect(350, 150, () => true))?.source).toEqual({ file: 'src/Checkout.tsx', line: 88, column: 1, kind: 'react-source-map' });
      await task.command({ kind: 'pick', enabled: true });
      await task.input(tabId, tab.generation, { kind: 'pointer', type: 'down', x: 350, y: 150, button: 'left', buttons: 1, clicks: 1, modifiers: 0 });
      expect(task.state().picked?.source).toEqual({ file: 'src/Checkout.tsx', line: 88, column: 1, kind: 'react-source-map' });
    } finally {
      await task.command({ kind: 'pick', enabled: false });
      await task.layout(800, 600, true, true);
      await page.evaluate(() => Reflect.deleteProperty(document.querySelector('#hover')!, '__reactFiber$test'));
    }
  });

  it.each(['angular', 'svelte', 'vue'])('preserves %s source precision through the human picker', async framework => {
    await page.evaluate(framework => {
      const element = document.querySelector('#hover')!;
      if (framework === 'angular') element.setAttribute('data-ng-source-location', 'src/checkout.component.html@o:120,l:87,c:2');
      if (framework === 'svelte') Object.defineProperty(element, '__svelte_meta', { configurable: true, value: { loc: { file: 'src/Checkout.svelte', line: 88, column: 2 } } });
      if (framework === 'vue') Object.defineProperty(element, '__vueParentComponent', { configurable: true, value: { type: { __file: 'src/Checkout.vue' } } });
    }, framework);
    const tab = task.page(tabId);
    try {
      const structural = await tab.inspect(350, 150);
      expect(structural?.source).toBeUndefined(); expect(structural?.componentSource).toBeUndefined();
      await task.command({ kind: 'pick', enabled: true });
      await task.input(tabId, tab.generation, { kind: 'pointer', type: 'down', x: 350, y: 150, button: 'left', buttons: 1, clicks: 1, modifiers: 0 });
      const picked = task.state().picked;
      if (framework === 'vue') {
        expect(picked?.source).toBeUndefined();
        expect(picked?.componentSource).toEqual({ file: 'src/Checkout.vue', framework: 'vue' });
      } else expect(picked?.source).toEqual({ file: framework === 'angular' ? 'src/checkout.component.html' : 'src/Checkout.svelte', line: 88, column: 3, kind: framework === 'angular' ? 'angular-template' : 'svelte-metadata' });
    } finally {
      await task.command({ kind: 'pick', enabled: false }); await task.layout(800, 600, true, true);
      await page.evaluate(() => {
        const element = document.querySelector('#hover')!;
        element.removeAttribute('data-ng-source-location');
        Reflect.deleteProperty(element, '__svelte_meta'); Reflect.deleteProperty(element, '__vueParentComponent');
      });
    }
  });

  it('serializes pipelined whole batches without broadcasting unchanged state', async () => {
    await page.locator('#field').focus();
    const revision = task.state().revision,
      generation = task.page(tabId).generation;
    const text = (value: string) => ({ kind: 'text' as const, text: value });
    await Promise.all([
      task.input(tabId, generation, {
        kind: 'batch',
        events: [text('a'), text('b')],
      }),
      task.input(tabId, generation, {
        kind: 'batch',
        events: [text('c'), text('d')],
      }),
    ]);
    expect(await page.locator('#field').inputValue()).toBe('abcd');
    expect(task.state().revision).toBe(revision);
  });

  it('publishes the final input generation after a viewport resize without another page action', async () => {
    const generations: number[] = [];
    const stop = task.subscribe(() => {
      generations.push(task.state().tabs.find(tab => tab.id === tabId)!.generation);
    });
    try {
      await task.layout(800, 560, true, true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(generations.at(-1)).toBe(task.page(tabId).generation);
    } finally { stop(); await task.layout(800, 600, true, true); }
  });

  it('finishes an in-flight viewport change before applying the latest layout and gates input throughout', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const applying = new Promise<void>(resolve => { entered = resolve; });
    const setViewport = page.setViewportSize.bind(page);
    const resize = jest.spyOn(page, 'setViewportSize').mockImplementationOnce(async viewport => {
      entered(); await gate;
      return setViewport(viewport);
    });
    const value = await page.locator('#field').inputValue();
    const first = task.layout(800, 520, true, true);
    let latest: Promise<void> | undefined;
    try {
      await applying;
      latest = task.layout(800, 580, true, true, 2);
      expect(task.page(tabId).ready).toBe(false);
      await expect(task.input(tabId, task.page(tabId).generation, { kind: 'text', text: 'stale-layout' })).rejects.toThrow();
      release();
      await Promise.all([first, latest]);
      expect(page.viewportSize()).toEqual({ width: 800, height: 580 });
      expect(task.page(tabId).ready).toBe(true);
      expect(await page.locator('#field').inputValue()).toBe(value);
      const frame = await task.page(tabId).nextFrame(0, new AbortController().signal);
      expect(frame).toMatchObject({ width: 800, height: 580, pixelRatio: 2, displayEpoch: task.page(tabId).displayEpoch });
    } finally {
      release(); await Promise.allSettled([first, latest]); resize.mockRestore();
      await task.layout(800, 600, true, true);
    }
  });

  it('rejects queued input after hiding and showing the same document', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = jest.spyOn(RuntimeBrowserInput.prototype, 'dispatch');
    const original = dispatch.getMockImplementation();
    if (!original) throw new Error('Input fixture delegate unavailable');
    dispatch.mockImplementationOnce(async function (
      this: RuntimeBrowserInput,
      input,
      current,
    ) {
      await held;
      return original.call(this, input, current);
    });
    const generation = task.page(tabId).generation;
    const first = task.input(tabId, generation, {
      kind: 'text',
      text: 'stale',
    });
    const second = task.input(tabId, generation, {
      kind: 'text',
      text: 'queued',
    });
    const results = Promise.allSettled([first, second]);
    while (!dispatch.mock.calls.length)
      await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await task.layout(800, 600, false);
      await task.layout(800, 600, true, true);
      release();
      expect((await results).map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      expect(await page.locator('#field').inputValue()).toBe('abcd');
    } finally {
      release();
      dispatch.mockRestore();
    }
  });

  it('streams one-shot CSS hover changes, clears hover on exit and accepts clicks without switching tabs', async () => {
    const tab = task.page(tabId), signal = new AbortController().signal;
    let after = 0;
    const untilPixel = async (green: boolean) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const frame = await tab.nextFrame(after, signal, 1000);
        if (!frame) continue;
        after = frame.sequence;
        const pixel = await page.evaluate(async ({ jpeg }) => {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
          try {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            return [...context.getImageData(350, 150, 1, 1).data];
          } finally { bitmap.close(); }
        }, { jpeg: [...frame.jpeg] });
        if (green ? pixel[1] > 150 && pixel[2] < 100 : pixel[2] > 150 && pixel[1] < 100) return;
      }
      throw new Error('The streamed hover image did not update');
    };
    await task.layout(800, 600, true, true);
    await untilPixel(false);
    const generation = tab.generation;
    const pointer = { kind: 'pointer' as const, x: 350, y: 150, button: 'none' as const, buttons: 0, clicks: 0, modifiers: 0 };
    await task.input(tabId, generation, { ...pointer, type: 'move' });
    await untilPixel(true);
    await task.input(tabId, generation, { kind: 'pointer-exit' });
    await untilPixel(false);
    await task.input(tabId, generation, { kind: 'batch', events: [
      { ...pointer, type: 'down', button: 'left', buttons: 1, clicks: 1 },
      { ...pointer, type: 'up', button: 'left', clicks: 1 },
    ] });
    expect(await page.locator('#hover').getAttribute('data-clicks')).toBe('1');
    await task.layout(800, 600, false);
    await task.layout(800, 600, true, true);
    await task.input(tabId, tab.generation, { kind: 'pointer-exit' });
    await untilPixel(false);
    expect(task.state().active).toBe(tabId);
  });

  it('adopts a background popup without replacing the selected user tab', async () => {
    const other = await task.create('you', null, '');
    const opening = context.waitForEvent('page');
    await page.evaluate(() => { window.open('/popup'); });
    const popup = await opening;
    for (let i = 0; i < 200 && ![...task.tabs.values()].some(tab => tab.owns(popup)); i++) await new Promise(resolve => setTimeout(resolve, 25));
    expect([...task.tabs.values()].some(tab => tab.owns(popup))).toBe(true);
    expect(task.page(tabId).driver).toBe('needs');
    expect(task.active).toBe(other.id);
    expect(other.driver).toBe('you');
    await popup.close();
    const orphanOpening = context.waitForEvent('page');
    await page.evaluate(() => { window.open('/popup', '_blank', 'noopener'); });
    const orphan = await orphanOpening;
    for (let i = 0; i < 200 && !orphan.isClosed() && ![...task.tabs.values()].some(tab => tab.owns(orphan)); i++) await new Promise(resolve => setTimeout(resolve, 25));
    if (!orphan.isClosed()) {
      await orphan.waitForURL(location => location.pathname === '/popup', { waitUntil: 'domcontentloaded' });
      expect(await orphan.evaluate(() => window.opener === null)).toBe(true);
      await orphan.close();
    }
    expect(other.driver).toBe('you');
  });
});

it('acknowledges layout while a task-owned engine is still starting', async () => {
  const pool = new RuntimeBrowserPool();
  let reject!: (error: Error) => void;
  const opening = new Promise<BrowserContext>((_resolve, no) => {
    reject = no;
  });
  const acquire = jest.spyOn(pool, 'acquire').mockReturnValue(opening);
  const task = new RuntimeBrowserTask(1, pool, 'f'.repeat(64));
  task.restore({
    active: 0,
    tabs: [
      {
        url: 'https://example.com',
        width: 'full',
        by: 'you',
        agentSessionId: null,
      },
    ],
  });
  try {
    await task.layout(800, 600, true, true);
    while (!acquire.mock.calls.length)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(task.state().tabs[0].loading).toBe(true);
  } finally {
    reject(new Error('Stopped fixture startup'));
    await task.destroy();
    await pool.onModuleDestroy();
    acquire.mockRestore();
  }
});
