import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

jest.setTimeout(90000);
describe('Browser code in sandboxed Chromium', () => {
  let root: string,
    fixture: Server,
    url: string,
    pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask;
  let oldRoot: string | undefined;
  const run = (code: string, timeoutMs = 15000, sessionId = 2) =>
    task.code(
      sessionId,
      { kind: 'code', code, timeoutMs },
      new AbortController().signal,
    );
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-browser-code-'));
    oldRoot = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = root;
    fixture = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><title>Code browser</title><style>body{font:20px sans-serif;padding:30px}input,button{font:inherit;display:block;margin:20px}</style><h1>Code-first browser</h1><input aria-label="Name"><button onclick="document.querySelector('h1').textContent=document.querySelector('input').value;console.log('saved');fetch('/saved')">Save</button><script>window.trusted=[];for(const type of ['mousedown','input','keydown']) addEventListener(type,e=>trusted.push([type,e.isTrusted]));console.log('loaded');</script>`,
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, '127.0.0.1', resolve),
    );
    const address = fixture.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture unavailable');
    url = 'http://localhost:' + address.port;
    pool = new RuntimeBrowserPool();
    task = new RuntimeBrowserTask(1, pool, 'e'.repeat(64));
  });
  afterAll(async () => {
    await task?.destroy();
    await pool?.onModuleDestroy();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    if (oldRoot === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  it('navigates, targets AX refs, types, verifies trusted events and emits images in one call', async () => {
    const result = await run(`
      state.tab = await browser.tabs.new(${JSON.stringify(url)});
      await state.tab.waitFor(() => !!document.querySelector('button'));
      const snapshot = await state.tab.snapshot({interactive:true});
      console.log(snapshot.text);
      const input = snapshot.text.split('\\n').find(line=>line.includes('textbox'));
      await state.tab.fill(input.match(/ref=([^\\]]+)/)[1], 'Finished');
      await state.tab.click('button');
      await state.tab.waitFor(() => document.querySelector('h1').textContent==='Finished');
      await state.tab.screenshot();
      return {trusted: await state.tab.evaluate(() => trusted), events: await state.tab.events()};
    `);
    expect(result.error).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0].data, 'base64').subarray(0, 2)).toEqual(
      Buffer.from([255, 216]),
    );
    await writeFile(
      join(root, 'browser-code.jpg'),
      Buffer.from(result.images[0].data, 'base64'),
    );
    const value = result.value as {
      trusted: [string, boolean][];
      events: { items: { method: string; params: unknown }[] };
    };
    expect(value.trusted).toEqual(
      expect.arrayContaining([
        ['input', true],
        ['mousedown', true],
      ]),
    );
    expect(
      value.events.items.some(
        (event) =>
          event.method === 'Runtime.consoleAPICalled' &&
          JSON.stringify(event.params).includes('loaded'),
      ),
    ).toBe(true);
    expect(
      value.events.items.some(
        (event) => event.method === 'Network.responseReceived',
      ),
    ).toBe(true);
    const artifact = resolve(__dirname, '../../../../artifacts/browser-mcp');
    await mkdir(artifact, { recursive: true });
    await writeFile(
      join(artifact, 'chromium.jpg'),
      Buffer.from(result.images[0].data, 'base64'),
    );
  });
  it('keeps tabs usable after page-evaluation timeout and rejects human-owned reads', async () => {
    const timed = await run(
      'await state.tab.evaluate(() => new Promise(() => {}))',
      500,
    );
    expect(timed.error?.outcomeUnknown).toBe(true);
    const resumed = await run(
      'const tabs=await browser.tabs.list(); state.tab=await browser.tabs.get(tabs.find(t=>t.owned).id); return await state.tab.evaluate(() => document.title)',
    );
    expect(resumed.error).toBeUndefined();
    expect(resumed.value).toBe('Code browser');
    const tab = [...task.tabs.values()][0];
    tab.stopAgent();
    expect(
      (await run('return await state.tab.screenshot()')).error,
    ).toBeDefined();
    expect(
      (
        await run(
          'return await browser.tabs.get((await browser.tabs.list())[0].id)',
          15000,
          3,
        )
      ).error,
    ).toBeDefined();
    tab.handoff(2);
    expect(
      (await run('return await state.tab.snapshot()')).error,
    ).toBeDefined();
    const reacquired = await run(
      'state.tab=await browser.tabs.get((await browser.tabs.list()).find(t=>t.owned).id); return await state.tab.evaluate(()=>document.title)',
    );
    expect(reacquired.error).toBeUndefined();
    expect(reacquired.value).toBe('Code browser');
  });
});
