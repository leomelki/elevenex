import type { BrowserContext } from 'playwright-core';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { RuntimeBrowserStream } from './runtime-stream.js';
import { RuntimeBrowserController } from './runtime-browser.controller.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import { RuntimeBrowserPersistence } from './runtime-persistence.js';
import { DesktopBrowserService } from './desktop-browser.service.js';
import type { TasksService } from '../tasks/tasks.service.js';
import type { TaskBrowserServers } from './task-browser-servers.js';
import type { BrowserAgentState } from '@elevenex/shared';

jest.setTimeout(90000);
it('starts agent tabs without a viewer and retains the live document, network and driver through viewer disconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-headless-browser-'));
  const previous = process.env['ELEVENEX_DATA_ROOT'];
  process.env['ELEVENEX_DATA_ROOT'] = root;
  let site: Server | undefined,
    pool: RuntimeBrowserPool | undefined,
    runtime: RuntimeBrowserService | undefined,
    mailbox: DesktopBrowserService | undefined;
  let clicks = 0;
  let channel: Server | undefined,
    gateway: RuntimeBrowserStream | undefined,
    viewer: WebSocket | undefined;
  try {
    site = createServer((request, response) => {
      if (request.url === '/clicked') {
        clicks++;
        response.end('ok');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        '<!doctype html><style>body{margin:0}button{width:200px;height:100px}</style><button onclick="fetch(\'/clicked\')">Run action</button><script>window.retained=crypto.randomUUID()</script>',
      );
    });
    await new Promise<void>((resolve) => site!.listen(0, '127.0.0.1', resolve));
    const address = site.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture unavailable');
    const url = `http://localhost:${address.port}/`;
    pool = new RuntimeBrowserPool();
    let ownedContext: Promise<BrowserContext> | undefined;
    const acquire = pool.acquire.bind(pool);
    const acquired = jest
      .spyOn(pool, 'acquire')
      .mockImplementation((...args) => {
        ownedContext = acquire(...args);
        return ownedContext;
      });
    runtime = new RuntimeBrowserService(pool, new RuntimeBrowserPersistence());
    const tasks = {
      record: () =>
        Promise.resolve({
          id: 1,
          repoId: 1,
          createdAt: 'now',
          taskState: 'ready',
          archivedAt: null,
        }),
    } as unknown as TasksService;
    const ports = {
      ports: () => Promise.resolve([address.port]),
    } as unknown as TaskBrowserServers;
    mailbox = new DesktopBrowserService(runtime, tasks, ports);
    const signal = new AbortController().signal;
    const opened = (await mailbox.request(
      1,
      2,
      { kind: 'open', url },
      signal,
    )) as BrowserAgentState;
    expect(opened.tabs[0]).toMatchObject({ driver: 'agent', ready: true });
    const task = runtime.active(1)!;
    if (!ownedContext) throw new Error('Browser context was not acquired');
    const context = await ownedContext;
    const page = context.pages()[0];
    const marker = await page.evaluate<string>('window.retained');
    const view = await runtime.connect(
      1,
      'viewer',
      createHash('sha256')
        .update(JSON.stringify([1, 1, 'now']))
        .digest('hex'),
    );
    await task.layout(800, 600, true, true);
    const before = task.page(opened.tabs[0].id).generation;
    channel = createServer();
    gateway = new RuntimeBrowserStream(runtime);
    gateway.attachToServer(
      channel,
      new RuntimeBrowserController(
        runtime,
        tasks,
        {} as SessionsService,
        ports,
      ),
    );
    const socketPath = join(root, 'viewer.sock');
    await new Promise<void>((resolve) => channel!.listen(socketPath, resolve));
    viewer = new WebSocket(
      `ws+unix://${socketPath}:/api/desktop-browser/runtime/tasks/1/stream`,
      { headers: { 'x-elevenex-browser-view': view.token } },
    );
    const jpeg = new Promise<Buffer>((resolve, reject) => {
      viewer!.on('message', (bytes, binary) => {
        if (binary && Buffer.isBuffer(bytes)) resolve(bytes);
      });
      viewer!.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      viewer!.once('open', resolve);
      viewer!.once('error', reject);
    });
    viewer.send(
      JSON.stringify({
        id: 1,
        method: 'frame',
        body: { tabId: opened.tabs[0].id, after: 0 },
      }),
    );
    const packet = await jpeg;
    const headerSize = packet.readUInt32BE(0);
    expect(
      JSON.parse(packet.subarray(4, 4 + headerSize).toString()),
    ).toMatchObject({ id: 1, width: 800, height: 600 });
    expect(packet.subarray(4 + headerSize, 6 + headerSize)).toEqual(
      Buffer.from([255, 216]),
    );
    const video = new Promise<Buffer>((resolve, reject) => {
      viewer!.on('message', (bytes, binary) => {
        if (binary && Buffer.isBuffer(bytes)) resolve(bytes);
        else if (!binary && bytes.toString().includes('video-ended')) reject(new Error('Video encoder failed'));
      });
    });
    viewer.send(JSON.stringify({ id: 2, method: 'video', body: { action: 'start', tabId: opened.tabs[0].id, subscription: '11111111-1111-4111-8111-111111111111', sequence: 0 } }));
    const videoPacket = await video;
    const videoHeaderLength = videoPacket.readUInt32BE(0);
    expect(JSON.parse(videoPacket.subarray(4, 4 + videoHeaderLength).toString())).toMatchObject({ event: 'video', width: 800, height: 600, video: { codec: 'avc1.42E02A', key: true } });
    runtime.disconnect(1, view.token);
    viewer.terminate();
    expect(task.page(opened.tabs[0].id).generation).toBe(before);
    expect(await page.evaluate<string>('window.retained')).toBe(marker);
    const listed = (await mailbox.request(
      1,
      2,
      { kind: 'list' },
      signal,
    )) as BrowserAgentState;
    expect(listed.tabs[0]).toMatchObject({ driver: 'agent', ready: true });
    await mailbox.request(
      1,
      2,
      {
        kind: 'click',
        tabId: listed.tabs[0].id,
        generation: listed.tabs[0].generation,
        x: 100,
        y: 50,
        step: 'Run action',
      },
      signal,
    );
    // Await the actual task-network side effect, not only a CDP input receipt.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (clicks) resolve();
        else if (Date.now() > deadline)
          reject(new Error('Headless click was not delivered'));
        else setTimeout(check, 10);
      };
      check();
    });
    expect(clicks).toBe(1);
    expect(acquired).toHaveBeenCalledTimes(1);
    expect(await page.evaluate<string>('window.retained')).toBe(marker);
  } finally {
    viewer?.terminate();
    await gateway?.onModuleDestroy();
    await new Promise<void>((resolve) =>
      channel ? channel.close(() => resolve()) : resolve(),
    );
    mailbox?.onModuleDestroy();
    await runtime?.onModuleDestroy();
    await pool?.onModuleDestroy();
    await new Promise<void>((resolve) =>
      site ? site.close(() => resolve()) : resolve(),
    );
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
  }
});
