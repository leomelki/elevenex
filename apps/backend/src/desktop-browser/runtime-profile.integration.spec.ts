import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';

jest.setTimeout(90000);

it('retains Chromium site data after host restart and isolates task profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-browser-profile-'));
  const previousRoot = process.env['ELEVENEX_DATA_ROOT'];
  process.env['ELEVENEX_DATA_ROOT'] = root;
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Storage fixture</title>');
  });
  let pool = new RuntimeBrowserPool();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const url = 'http://127.0.0.1:' + address.port;
    const identity = 'b'.repeat(64);
    const context = await pool.acquire(identity, { permissions: [], acceptDownloads: false });
    await expect(pool.acquire(identity, {})).rejects.toThrow('already open');
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(async () => {
      document.cookie = 'login=retained; Max-Age=86400; SameSite=Lax';
      localStorage.setItem('preference', 'retained');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('profile', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('values');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('values', 'readwrite');
          transaction.objectStore('values').put('retained', 'login');
          transaction.oncomplete = () => { database.close(); resolve(); };
          transaction.onerror = () => { database.close(); reject(transaction.error); };
        };
      });
      const cache = await caches.open('profile');
      await cache.put('/cached', new Response('retained'));
    });
    const other = await pool.acquire('c'.repeat(64), {});
    const otherPage = await other.newPage();
    await otherPage.goto(url);
    expect(await otherPage.evaluate(() => [document.cookie, localStorage.getItem('preference')])).toEqual(['', null]);
    await pool.onModuleDestroy();
    pool = new RuntimeBrowserPool();
    const restored = await pool.acquire(identity, {});
    const restoredPage = await restored.newPage();
    await restoredPage.goto(url);
    expect(await restoredPage.evaluate(async () => {
      const databaseValue = await new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('profile', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('values', 'readonly');
          const value = transaction.objectStore('values').get('login');
          value.onsuccess = () => resolve(value.result);
          transaction.oncomplete = () => database.close();
        };
      });
      return [document.cookie, localStorage.getItem('preference'), databaseValue, await (await caches.match('/cached'))?.text()];
    })).toEqual(['login=retained', 'retained', 'retained', 'retained']);
    expect((await stat(join(root, 'task-browser-profiles', identity))).mode & 0o777).toBe(0o700);
    await expect(pool.acquire('../escape', {})).rejects.toThrow('Invalid browser profile');
  } finally {
    await pool.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRoot === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
