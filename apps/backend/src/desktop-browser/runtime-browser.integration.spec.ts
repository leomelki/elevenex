import { RuntimeBrowserPersistence } from './runtime-persistence.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { RuntimeBrowserController } from './runtime-browser.controller.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { TasksService } from '../tasks/tasks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { DesktopBrowserService } from './desktop-browser.service.js';

jest.setTimeout(90000);
describe('Remote browser public HTTP behavior', () => {
  let app: INestApplication,
    fixture: Server,
    tcp: Server,
    tcpUrl: string,
    root: string,
    base: string,
    pageUrl: string,
    token: string,
    tabId: string;
  let events: string[] = [];
  let runtime: RuntimeBrowserService;
  let pool: RuntimeBrowserPool;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let oldRoot: string | undefined;
  const request = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: base,
          path: '/desktop-browser/runtime/tasks/1/' + path,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-elevenex-browser-view': token ?? '',
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 3100000) {
              req.destroy();
              reject(new Error('Test response exceeded bounds'));
            } else chunks.push(chunk);
          });
          res.once('end', () => {
            const bytes = Buffer.concat(chunks);
            resolve(
              new Response(
                res.statusCode === 204 ? null : new Uint8Array(bytes),
                { status: res.statusCode ?? 200 },
              ),
            );
          });
        },
      );
      req.once('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-runtime-browser-'));
    oldRoot = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = root;
    fixture = createServer((req, res) => {
      if (req.url === '/dialog') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          "<!doctype html><script>confirm('private-dialog-fixture')</script>",
        );
        return;
      }
      if (req.url === '/event') {
        let text = '';
        req.on('data', (chunk) => {
          text += String(chunk);
        });
        req.on('end', () => {
          events.push(text);
          res.end('ok');
        });
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        "<!doctype html><meta charset=\"utf-8\"><style>body{margin:16px}input{display:block;width:200px;height:36px}button{margin-top:16px;height:36px}</style><input type=\"password\" oninput=\"fetch('/event',{method:'POST',body:this.value})\"><button onclick=\"fetch('/event',{method:'POST',body:'clicked'})\">Run action</button><script>navigator.permissions.query({name:'geolocation'}).then(p=>fetch('/event',{method:'POST',body:'permission:'+p.state}))</script>",
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, '127.0.0.1', resolve),
    );
    const address = fixture.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture address unavailable');
    pageUrl = 'http://localhost:' + address.port;
    const module = await Test.createTestingModule({
      controllers: [RuntimeBrowserController],
      providers: [
        RuntimeBrowserPersistence,
        RuntimeBrowserPool,
        RuntimeBrowserService,
        {
          provide: TasksService,
          useValue: {
            record: async () => ({
              id: 1,
              taskState: 'ready',
              archivedAt: null,
            }),
          },
        },
        {
          provide: SessionsService,
          useValue: {
            findOne: async (id: number) => ({
              workspaceId: id === 2 ? 1 : 9,
              status: 'active',
            }),
          },
        },
        {
          provide: TaskBrowserServers,
          useValue: { ports: async () => [address.port] },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    base = join(root, 'browser.sock');
    await app.listen(base);
    runtime = module.get(RuntimeBrowserService);
    pool = module.get(RuntimeBrowserPool);
    tcp = createServer(app.getHttpAdapter().getInstance());
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const tcpAddress = tcp.address();
    if (!tcpAddress || typeof tcpAddress === 'string')
      throw new Error('TCP fixture unavailable');
    tcpUrl = 'http://127.0.0.1:' + tcpAddress.port;
  });
  afterAll(async () => {
    clearInterval(heartbeat);
    await app?.close();
    await new Promise<void>((resolve) => {
      tcp?.close(() => resolve());
      tcp?.closeAllConnections();
    });
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = oldRoot;
  });
  it('denies pixels and viewer leases on originless TCP and browser-origin IPC requests', async () => {
    expect(
      (
        await fetch(tcpUrl + '/desktop-browser/runtime/tasks/1/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: '11111111-1111-4111-8111-111111111111',
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('initial', undefined, {
          Origin: 'https://untrusted.example',
        })
      ).status,
    ).toBe(403);
  });
  it('waits for cancelled startup during host disposal and never restarts a disposed host', async () => {
    const owned = new RuntimeBrowserPool();
    const opening = owned.acquire();
    const stopped = owned.onModuleDestroy();
    await expect(opening).rejects.toThrow('Browser runtime stopped');
    await stopped;
    await expect(owned.acquire()).rejects.toThrow('Browser runtime stopped');
  });
  it('opens sandboxed task-hosted Chromium, streams bounded binary frames, types privately and reconciles ownership', async () => {
    const connected = await request('connect', {
      clientId: '11111111-1111-4111-8111-111111111111',
    }).then((r) => r.json());
    token = connected.token;
    expect(typeof token).toBe('string');
    heartbeat = setInterval(() => {
      void request('state').catch(() => undefined);
    }, 1000);
    const blank = await request('command', { kind: 'new-tab' }).then((r) =>
      r.json(),
    );
    expect(blank.tabs).toHaveLength(1);
    expect(blank.tabs[0]).toMatchObject({
      url: '',
      title: 'New tab',
      loading: false,
      driver: 'you',
    });
    const openedResponse = await request('command', {
      kind: 'navigate',
      tabId: blank.active,
      url: pageUrl,
    });
    expect(openedResponse.status).toBe(201);
    for (let n = 0; n < 100 && !events.includes('permission:denied'); n++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain('permission:denied');
    const opened = await openedResponse.json();
    tabId = opened.active;
    const layout = await request('layout', {
      width: 800,
      height: 600,
      visible: true,
      interactive: true,
      pixelRatio: 1,
    }).then((r) => r.json());
    let generation = layout.tabs[0].generation;
    const frame = await request('frame?tabId=' + tabId + '&after=0');
    expect(frame.status).toBe(200);
    const bytes = Buffer.from(await frame.arrayBuffer());
    const header = JSON.parse(
      bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString(),
    );
    expect(header.width).toBe(800);
    expect(bytes.length).toBeLessThan(3001024);
    expect(bytes[4 + bytes.readUInt32BE(0)]).toBe(0xff);
    const pointer = async (type: 'down' | 'up', x: number, y: number) => {
      const reply = await request('input', {
        tabId,
        generation,
        input: {
          kind: 'pointer',
          type,
          x,
          y,
          button: 'left',
          buttons: type === 'down' ? 1 : 0,
          clicks: 1,
          modifiers: 0,
        },
      });
      expect(reply.status).toBe(201);
      generation = (await reply.json()).generation;
    };
    await pointer('down', 30, 30);
    await pointer('up', 30, 30);
    expect(
      (
        await request('input', {
          tabId,
          generation,
          input: { kind: 'text', text: 'private-test-世界' },
        })
      ).status,
    ).toBe(201);
    for (let n = 0; n < 100 && !events.includes('private-test-世界'); n++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain('private-test-世界');
    const batch = await request('input', {
      tabId,
      generation,
      input: {
        kind: 'batch',
        events: [
          {
            kind: 'key',
            type: 'down',
            key: 'a',
            code: 'KeyA',
            keyCode: 65,
            modifiers: 0,
          },
          { kind: 'text', text: '-batch' },
          {
            kind: 'key',
            type: 'up',
            key: 'a',
            code: 'KeyA',
            keyCode: 65,
            modifiers: 0,
          },
        ],
      },
    });
    expect(batch.status).toBe(201);
    generation = (await batch.json()).generation;
    for (let n = 0; n < 100 && !events.includes('private-test-世界-batch'); n++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain('private-test-世界-batch');
    expect(
      (
        await request('input', {
          tabId,
          generation,
          input: {
            kind: 'batch',
            events: [{ kind: 'clipboard', operation: 'copy' }],
          },
        })
      ).status,
    ).toBe(400);

    expect(
      JSON.stringify(await request('state').then((r) => r.json())),
    ).not.toContain('private-test-世界');
    expect(
      (await request('command', { kind: 'handoff', tabId, sessionId: 99 }))
        .status,
    ).toBe(403);
    const handed = await request('command', {
      kind: 'handoff',
      tabId,
      sessionId: 2,
    }).then((r) => r.json());
    generation = handed.tabs[0].generation;
    const mailbox = new DesktopBrowserService(runtime);
    try {
      const reply = await mailbox.request(
        1,
        2,
        { kind: 'list' },
        new AbortController().signal,
      );
      expect(JSON.stringify(reply)).not.toContain('private-test-世界');
      expect(reply).toMatchObject({ observation: 'withheld' });
    } finally {
      mailbox.onModuleDestroy();
    }
    await pointer('down', 30, 30);
    expect(generation).toBeGreaterThan(handed.tabs[0].generation);
    expect((await request('state').then((r) => r.json())).tabs[0].driver).toBe(
      'you',
    );
    expect(
      (
        await request('input', {
          tabId,
          generation: handed.tabs[0].generation,
          input: { kind: 'text', text: 'stale' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request('command', { kind: 'open', url: 'file:///etc/passwd' }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await request('state', undefined, {
          'x-elevenex-browser-view': '11111111-1111-4111-8111-111111111111',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const second = await request('command', {
      kind: 'open',
      url: pageUrl + '/second',
    }).then((r) => r.json());
    const secondId = second.active;
    expect(second.tabs).toHaveLength(2);
    expect(secondId).not.toBe(tabId);
    await request('command', { kind: 'select', tabId });
    expect((await request('state').then((r) => r.json())).active).toBe(tabId);
    const resized = await request('layout', {
      width: 390,
      height: 600,
      visible: true,
      interactive: true,
      pixelRatio: 2,
      sequence: 3,
    }).then((r) => r.json());
    expect(
      resized.tabs.find((tab: { id: string }) => tab.id === tabId).driver,
    ).toBe('you');
    const resizedFrame = await request(
      'frame?tabId=' + tabId + '&after=' + header.sequence,
    );
    expect(resizedFrame.status).toBe(200);
    const resizedBytes = Buffer.from(await resizedFrame.arrayBuffer());
    const resizedHeader = JSON.parse(
      resizedBytes.subarray(4, 4 + resizedBytes.readUInt32BE(0)).toString(),
    );
    expect(resizedHeader.width).toBe(390);
    expect(resizedHeader.height).toBe(600);
    const hidden = await request('layout', {
      width: 390,
      height: 600,
      visible: false,
      interactive: false,
      pixelRatio: 1,
      sequence: 5,
    }).then((r) => r.json());
    expect(
      (
        await request('input', {
          tabId,
          generation: hidden.tabs.find(
            (tab: { id: string }) => tab.id === tabId,
          ).generation,
          input: { kind: 'text', text: 'hidden' },
        })
      ).status,
    ).toBe(400);
    await request('layout', {
      width: 800,
      height: 600,
      visible: true,
      interactive: true,
      pixelRatio: 1,
      sequence: 4,
    });
    expect(
      (await request('state').then((r) => r.json())).tabs.find(
        (tab: { id: string }) => tab.id === tabId,
      ).ready,
    ).toBe(false);
    await request('command', { kind: 'close', tabId: secondId });
    await request('disconnect', {});
    expect((await request('state')).status).toBeGreaterThanOrEqual(400);
    const previousToken = token;
    const reconnected = await request('connect', {
      clientId: '11111111-1111-4111-8111-111111111111',
    }).then((r) => r.json());
    token = reconnected.token;
    expect(token).not.toBe(previousToken);
    expect(reconnected.state.tabs[0].driver).toBe('you');
    expect(
      (
        await request('state', undefined, {
          'x-elevenex-browser-view': previousToken,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const contested = await request('connect', {
      clientId: '22222222-2222-4222-8222-222222222222',
    });
    expect(contested.status).toBe(409);
    await (await pool.acquire()).close();
    const crashed = await request('state').then((r) => r.json());
    expect(crashed.tabs[0].driver).toBe('needs');
    expect(crashed.tabs[0].error).toBeTruthy();
    const recoveredResponse = await request('command', {
      kind: 'reload',
      tabId,
    });
    expect(recoveredResponse.status).toBe(201);
    const recovered = await recoveredResponse.json();
    expect(recovered.tabs[0].error).toBeNull();
    expect(recovered.tabs[0].driver).toBe('you');
    await request('layout', {
      width: 800,
      height: 600,
      visible: true,
      interactive: true,
      pixelRatio: 1,
      sequence: 10,
    });
    const freshHandoff = await request('command', {
      kind: 'handoff',
      tabId,
      sessionId: 2,
    }).then((r) => r.json());
    const beforeStale = freshHandoff.tabs[0].generation;
    expect(
      (
        await request('input', {
          tabId,
          generation: beforeStale - 1,
          input: {
            kind: 'pointer',
            type: 'down',
            x: 20,
            y: 20,
            button: 'left',
            buttons: 1,
            clicks: 1,
            modifiers: 0,
          },
        })
      ).status,
    ).toBe(400);
    expect((await request('state').then((r) => r.json())).tabs[0].driver).toBe(
      'you',
    );
    await request('command', { kind: 'pick', enabled: true });
    let picking = await request('state').then((r) => r.json());
    await request('input', {
      tabId,
      generation: picking.tabs[0].generation,
      input: {
        kind: 'pointer',
        type: 'down',
        x: 30,
        y: 30,
        button: 'left',
        buttons: 1,
        clicks: 1,
        modifiers: 0,
      },
    });
    picking = await request('state').then((r) => r.json());
    expect(picking.picked).toBeNull();
    expect(picking.pickerMessage).toMatch(/private/);
    const dialog = await request('command', {
      kind: 'navigate',
      tabId,
      url: pageUrl + '/dialog',
    }).then((r) => r.json());
    expect(dialog.attention).toMatchObject({
      kind: 'dialog',
      tabId,
      outside: true,
    });
    expect(JSON.stringify(dialog)).not.toContain('private-dialog-fixture');
    const next = await request('command', {
      kind: 'open',
      url: pageUrl + '/next',
    }).then((r) => r.json());
    expect(next.active).not.toBe(tabId);
    expect(next.attention.tabId).toBe(tabId);
    const closed = await request('command', { kind: 'close', tabId }).then(
      (r) => r.json(),
    );
    expect(closed.attention).toBeUndefined();
    const start = await request('command', { kind: 'new-tab' }).then((r) =>
      r.json(),
    );
    const handedStart = await request('command', {
      kind: 'handoff',
      tabId: start.active,
      sessionId: 2,
    }).then((r) => r.json());
    const startGeneration = handedStart.tabs.find(
      (tab: { id: string }) => tab.id === start.active,
    ).generation;
    await runtime
      .viewer(1, token)
      .agent(
        {
          kind: 'navigate',
          tabId: start.active,
          generation: startGeneration,
          url: pageUrl,
        },
        2,
        new AbortController().signal,
      );
    expect(
      runtime
        .viewer(1, token)
        .state()
        .tabs.find((tab) => tab.id === start.active),
    ).toMatchObject({ url: new URL(pageUrl).href, error: null });
    await request('disconnect', {});
  });
  it('presents a detached remote tab independently and rejects hidden or stale input', async () => {
    const connected = await request('connect', { clientId: '22222222-2222-4222-8222-222222222222' }).then(response => response.json());
    token = connected.token;
    const opened = await request('command', { kind: 'open', url: pageUrl }).then(response => response.json());
    const detachedId: string = opened.active;
    const box = { tabId: detachedId, width: 720, height: 480, visible: true, interactive: true, pixelRatio: 1 };
    expect((await request('layout', { ...box, sequence: 1 })).status).toBe(201);
    const main = await request('command', { kind: 'new-tab' }).then(response => response.json());
    expect(main.active).not.toBe(detachedId);
    // The main panel can be hidden while the companion continues painting.
    await request('layout', { width: 800, height: 600, visible: false, interactive: false, pixelRatio: 1, sequence: 2 });
    const frame = await request('frame?tabId=' + detachedId + '&after=0');
    expect(frame.status).toBe(200);
    const bytes = Buffer.from(await frame.arrayBuffer());
    expect(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString()).width).toBe(720);
    const tab = main.tabs.find((tab: { id: string }) => tab.id === detachedId);
    expect((await request('input', { tabId: detachedId, generation: tab.generation, input: { kind: 'pointer', type: 'down', x: 30, y: 30, button: 'left', buttons: 1, clicks: 1, modifiers: 0 } })).status).toBe(201);
    await request('layout', { ...box, visible: false, interactive: false, sequence: 10 });
    await request('layout', { ...box, sequence: 9 });
    expect((await request('input', { tabId: detachedId, generation: tab.generation, input: { kind: 'text', text: 'must not be typed' } })).status).toBe(400);
    expect((await request('frame?tabId=' + detachedId + '&after=0')).status).toBe(400);
    await request('layout', { ...box, sequence: 11 });
    await request('command', { kind: 'handoff', tabId: detachedId, sessionId: 2 });
    const now = Date.now(), clock = jest.spyOn(Date, 'now').mockReturnValue(now + 3100);
    try {
      const expired = await runtime.viewer(1, token).agent({ kind: 'list' }, 2, new AbortController().signal);
      expect(expired.tabs.find(tab => tab.id === detachedId)?.driver).toBe('you');
      expect((await request('frame?tabId=' + detachedId + '&after=0')).status).toBe(400);
    } finally { clock.mockRestore(); }
    await request('layout', { ...box, detached: false, visible: false, interactive: false, sequence: 12 });
    await request('command', { kind: 'select', tabId: detachedId });
    await request('layout', { width: 800, height: 600, visible: true, interactive: true, pixelRatio: 1, sequence: 13 });
    expect((await request('frame?tabId=' + detachedId + '&after=0')).status).toBe(200);
    await request('disconnect', {});
  });

});
