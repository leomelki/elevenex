import type { BrowserContext, Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';

jest.setTimeout(90000);
describe('remote human browser workflows', () => {
  let root: string, previous: string | undefined, server: Server, url: string;
  let pool: RuntimeBrowserPool, task: RuntimeBrowserTask, context: BrowserContext, page: Page, tabId: string;
  const wait = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 25)); expect(condition()).toBe(true); };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-workflows-')); previous = process.env['ELEVENEX_DATA_ROOT']; process.env['ELEVENEX_DATA_ROOT'] = root;
    server = createServer((req, res) => {
      if (req.url === '/download') { res.setHeader('Content-Disposition', 'attachment; filename="example.txt"'); res.end('download bytes'); return; }
      if (req.url === '/large') { res.setHeader('Content-Disposition', 'attachment; filename="large.txt"'); res.setHeader('Content-Length', 40 * 1024 * 1024); res.write(Buffer.alloc(1024)); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Workflows</title><input type="file" id="file" multiple><a id="download" href="/download">Download</a><a id="large" href="/large">Large</a><button id="pointer" style="cursor:crosshair">Pointer</button>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture');
    url = 'http://127.0.0.1:' + address.port;
    pool = new RuntimeBrowserPool(); const acquire = pool.acquire.bind(pool);
    jest.spyOn(pool, 'acquire').mockImplementation(async (...args) => { context = await acquire(...args); return context; });
    task = new RuntimeBrowserTask(1, pool, 'd'.repeat(64)); const tab = await task.create('you', null, url); tabId = tab.id;
    page = context.pages().find(candidate => candidate.url() === url + '/')!;
    await task.layout(800, 600, true, true);
  });
  afterAll(async () => {
    await task?.destroy(); await pool?.onModuleDestroy(); server?.closeAllConnections();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT']; else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(root, { recursive: true, force: true });
  });
  const workflows = () => task.page(tabId).snapshot().workflows ?? [];
  it('adopts OAuth popups with opener, cookies, postMessage and close returning to the originating tab', async () => {
    await page.evaluate(url => { document.cookie = 'workflow=shared'; window.addEventListener('message', event => { document.title = event.data; }); window.open(url + '/popup'); }, url);
    await wait(() => task.tabs.size === 2 && task.active !== tabId);
    const popup = context.pages().find(candidate => candidate !== page && candidate.url() !== 'about:blank')!;
    expect(await popup.evaluate(() => !!window.opener && document.cookie.includes('workflow=shared'))).toBe(true);
    await popup.evaluate(() => { window.opener.postMessage('OAuth complete', location.origin); window.close(); });
    await wait(() => task.tabs.size === 1 && task.active === tabId);
    expect(await page.title()).toBe('OAuth complete');
  });
  it('preserves prompt text only for the viewer and resolves exact pending dialogs', async () => {
    await page.evaluate(() => { setTimeout(() => { document.title = prompt('Private prompt', 'default') ?? 'cancelled'; }, 0); });
    await wait(() => workflows().some(item => item.kind === 'dialog'));
    const request = workflows().find(item => item.kind === 'dialog')!;
    expect(JSON.stringify(await task.agent({ kind: 'list' }, 2, new AbortController().signal))).not.toContain('Private prompt');
    await task.command({ kind: 'dialog-response', tabId, requestId: request.id, accept: true, text: 'human response' });
    await wait(() => !workflows().length);
    expect(await page.title()).toBe('human response');
    await expect(task.command({ kind: 'dialog-response', tabId, requestId: request.id, accept: true, text: 'again' })).rejects.toThrow();
  });
  it('relays bounded multi-file input bytes and rejects stale requests after navigation', async () => {
    await page.locator('#file').click();
    await wait(() => workflows().some(item => item.kind === 'upload'));
    const request = workflows().find(item => item.kind === 'upload')!;
    const owner = task.page(tabId).workflows;
    await owner.transfer(request.id, { kind: 'upload-start', files: [{ name: 'hello.txt', size: 5 }, { name: 'empty.txt', size: 0 }] });
    await expect(owner.transfer(request.id, { kind: 'upload-chunk', index: 0, offset: 1, data: 'aGVsbG8=' })).rejects.toThrow();
    await owner.transfer(request.id, { kind: 'upload-chunk', index: 0, offset: 0, data: 'aGVsbG8=' });
    await owner.transfer(request.id, { kind: 'upload-finish' });
    expect(await page.locator('#file').evaluate(async (input: HTMLInputElement) => Promise.all([...input.files!].map(async file => [file.name, await file.text()])))).toEqual([['hello.txt', 'hello'], ['empty.txt', '']]);
    await page.locator('#file').click(); await wait(() => workflows().some(item => item.kind === 'upload'));
    const stale = workflows().find(item => item.kind === 'upload')!;
    await task.command({ kind: 'navigate', tabId, url: url + '/next' });
    await expect(owner.transfer(stale.id, { kind: 'upload-finish' })).rejects.toThrow();
  });
  it('relays downloads without exposing host paths, and cancels oversized responses', async () => {
    await page.locator('#download').click();
    await wait(() => workflows().some(item => item.kind === 'download' && item.status === 'ready'));
    const request = workflows().find(item => item.kind === 'download')!;
    expect(await task.page(tabId).workflows.transfer(request.id, { kind: 'download-read', offset: 0 })).toEqual({ offset: 0, size: 14, data: Buffer.from('download bytes').toString('base64') });
    await task.command({ kind: 'cancel-workflow', tabId, requestId: request.id });
    await page.locator('#large').click();
    await wait(() => workflows().length === 0);
  });
  it('preserves relative movement under genuine Chromium pointer lock and releases on hide', async () => {
    await task.command({ kind: 'takeover', tabId }); await task.layout(800, 600, true, true);
    await page.evaluate(() => {
      const button = document.querySelector('#pointer')!;
      button.addEventListener('click', () => { void document.body.requestPointerLock(); });
      document.addEventListener('mousemove', event => { if (document.pointerLockElement) document.title = event.movementX + ',' + event.movementY; });
    });
    const rect = await page.locator('#pointer').boundingBox();
    const x = rect!.x + 4, y = rect!.y + 4;
    const generation = task.page(tabId).generation;
    await task.input(tabId, generation, { kind: 'batch', events: [
      { kind: 'pointer', type: 'move', x, y, button: 'none', buttons: 0, clicks: 0, modifiers: 0 },
      { kind: 'pointer', type: 'down', x, y, button: 'left', buttons: 1, clicks: 1, modifiers: 0 },
      { kind: 'pointer', type: 'up', x, y, button: 'left', buttons: 0, clicks: 1, modifiers: 0 },
    ] });
    await wait(() => task.page(tabId).snapshot().pointerLocked === true);
    await task.input(tabId, task.page(tabId).generation, { kind: 'pointer-relative', deltaX: 17, deltaY: -9, buttons: 0, modifiers: 0 });
    expect(await page.title()).toBe('17,-9');
    await task.layout(800, 600, false, false);
    await wait(() => task.page(tabId).snapshot().pointerLocked === false);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
    await task.layout(800, 600, true, true);
  });
  it('relays CSS cursor keywords and dismisses pending dialogs on viewer loss', async () => {
    await task.command({ kind: 'takeover', tabId }); await task.layout(800, 600, true, true);
    const rect = await page.locator('#pointer').boundingBox();
    await task.input(tabId, task.page(tabId).generation, { kind: 'pointer', type: 'move', x: rect!.x + 4, y: rect!.y + 4, button: 'none', buttons: 0, clicks: 0, modifiers: 0 });
    await wait(() => task.page(tabId).snapshot().cursor === 'crosshair');
    await page.evaluate(() => { setTimeout(() => confirm('leave viewer'), 0); });
    await wait(() => workflows().some(item => item.kind === 'dialog'));
    task.reconcile(); await wait(() => workflows().length === 0);
  });
});
