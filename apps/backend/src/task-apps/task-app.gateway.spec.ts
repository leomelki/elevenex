import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createEdgeProxyServer } from '../proxy/edge-proxy.server.js';
import type { TasksService } from '../tasks/tasks.service.js';
import type { TaskAppHost } from './task-app-host.js';
import type { AppFrameListener } from './display-capture.js';
import { TaskAppGateway } from './task-app.gateway.js';
import { TaskAppController } from './task-app.controller.js';

describe('task app private desktop transport', () => {
  const taskId = 17,
    runId = '114ef083-a8c4-4d24-9d83-b744e9296367';
  const access = 'a'.repeat(64);
  const request = (headers: Record<string, string> = {}) =>
    ({ socket: { remoteAddress: '127.0.0.1' }, headers }) as IncomingMessage;
  const prior = process.env.ELEVENEX_CODE_ACCESS;
  beforeEach(() => {
    process.env.ELEVENEX_CODE_ACCESS = access;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.ELEVENEX_CODE_ACCESS;
    else process.env.ELEVENEX_CODE_ACCESS = prior;
  });

  const tasks = {
    record: async () => ({ taskState: 'ready' }),
  } as unknown as TasksService;
  it('rejects originless unauthenticated TCP, web-page headers and cross-task or replayed tickets', async () => {
    const app = {
      get: () => ({ status: 'running', mode: 'stream' }),
    } as unknown as TaskAppHost;
    const controller = new TaskAppController(tasks, app);
    await expect(controller.watch(request(), '17', runId)).rejects.toThrow(
      'Forbidden',
    );
    const headers = { 'x-elevenex-code-access': access };
    await expect(
      controller.watch(
        request({ ...headers, origin: 'http://localhost' }),
        '17',
        runId,
      ),
    ).rejects.toThrow('Forbidden');
    const { token } = await controller.watch(request(headers), '17', runId);
    const upgrade = request({ ...headers, 'x-elevenex-app-view': token });
    expect(controller.consume(upgrade, 12, runId)).toBe(false);
    expect(controller.consume(upgrade, 17, runId)).toBe(true);
    expect(controller.consume(upgrade, 17, runId)).toBe(false);
  });

  it('requires a viewer credential even when a local process connects to the remote Unix socket', async () => {
    const previous = process.env.ELEVENEX_DESKTOP_SOCKET;
    const previousAccess = process.env.ELEVENEX_APP_ACCESS;
    process.env.ELEVENEX_DESKTOP_SOCKET = '/private/backend.sock';
    process.env.ELEVENEX_APP_ACCESS = access;
    const approveApp = jest.fn().mockResolvedValue(undefined);
    const routes = new TaskAppController({ record: async () => ({ taskState: 'ready' }), approveApp } as unknown as TasksService, {} as TaskAppHost);
    const privateRequest = (headers: Record<string,string>) => ({ headers, socket: {} }) as IncomingMessage;
    try {
      await expect(routes.approve(privateRequest({}), '17', runId)).rejects.toThrow('Forbidden');
      expect(approveApp).not.toHaveBeenCalled();
      await expect(routes.approve(privateRequest({ 'x-elevenex-app-access': access }), '17', runId)).resolves.toEqual({ approved: true });
      expect(approveApp).toHaveBeenCalledWith(17, runId);
    } finally {
      if (previous === undefined) delete process.env.ELEVENEX_DESKTOP_SOCKET; else process.env.ELEVENEX_DESKTOP_SOCKET = previous;
      if (previousAccess === undefined) delete process.env.ELEVENEX_APP_ACCESS; else process.env.ELEVENEX_APP_ACCESS = previousAccess;
    }
  });

  it('only opens permission settings for an authenticated desktop viewer and forwards the owned target', async () => {
    const openSetupSettings = jest.fn().mockResolvedValue(undefined);
    const controller = new TaskAppController(tasks, { openSetupSettings } as unknown as TaskAppHost);
    await expect(controller.setupSettings(request(), '17', runId)).rejects.toThrow('Forbidden');
    expect(openSetupSettings).not.toHaveBeenCalled();
    const headers = { 'x-elevenex-code-access': access };
    await expect(controller.setupSettings(request(headers), '17', runId)).resolves.toEqual({ opened: true });
    expect(openSetupSettings).toHaveBeenCalledWith(17, runId);
  });

  it('delivers scoped binary video over the shipped edge and restarts a slow subscriber on a keyframe', async () => {
    let source!: AppFrameListener;
    const release = jest.fn(async () => undefined);
    let didStop!: () => void;
    const stopped = new Promise<void>(resolve => { didStop = resolve; });
    const stop = jest.fn(didStop);
    const host = {
      get: () => ({ status: 'running', mode: 'stream' }),
      watch: (_id: number, _run: string, listener: AppFrameListener) => {
        source = listener;
        return stop;
      },
      acquireInput: jest.fn(),
      input: jest.fn(async () => undefined),
      releaseInput: release,
    };
    const apps = host as unknown as TaskAppHost;
    const gateway = new TaskAppGateway(apps),
      routes = new TaskAppController(tasks, apps);
    const upstream = createServer(),
      edge = createEdgeProxyServer({
        repoRoot: join(__dirname, '../../../..'),
        localHttpServer: upstream,
      });
    gateway.attach(upstream, routes);
    edge.listen(0, '127.0.0.1');
    await once(edge, 'listening');
    const headers = { 'x-elevenex-code-access': access };
    const { token } = await routes.watch(request(headers), '17', runId);
    const ws = new WebSocket(
      `ws://127.0.0.1:${(edge.address() as AddressInfo).port}/api/task-apps/${taskId}/${runId}/stream`,
      { headers: { ...headers, 'x-elevenex-app-view': token } },
    );
    const frame = (key: boolean, value: number) =>
      source.frame({
        codec: 'avc1.42E02A',
        data: Buffer.from([0, 0, 1, key ? 5 : 1]),
        timestamp: value,
        key,
        width: 1280,
        height: 800,
      });
    try {
      const [ready] = await once(ws, 'message');
      expect(JSON.parse(ready.toString())).toEqual({ ready: true });
      const input = { kind: 'key', code: 'Enter', down: true };
      ws.send(JSON.stringify({ id: 1, input }));
      expect(JSON.parse((await once(ws, 'message'))[0].toString())).toEqual({
        id: 1,
        ok: false,
      });
      expect(host.input).not.toHaveBeenCalled();
      const arrived: number[] = [];
      ws.on('message', (raw, binary) => {
        if (binary && Buffer.isBuffer(raw)) arrived.push(raw.readDoubleBE(9));
      });
      for (let n = 1; n <= 8; n++) expect(frame(n === 1, n)).toBe(true);
      expect(frame(false, 9)).toBe(false);
      expect(frame(false, 10)).toBe(false);
      while (arrived.length < 8) await once(ws, 'message');
      ws.send(JSON.stringify({ ack: 8 }));
      ws.send(JSON.stringify({ id: 2, input }));
      expect(JSON.parse((await once(ws, 'message'))[0].toString())).toEqual({
        id: 2,
        ok: true,
      });
      expect(host.input).toHaveBeenCalledWith(
        taskId,
        runId,
        expect.any(String),
        input,
      );
      expect(frame(false, 11)).toBeUndefined();
      expect(frame(true, 12)).toBe(true);
      await once(ws, 'message');
      expect(arrived).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 12]);
    } finally {
      const closed = once(ws, 'close');
      ws.close();
      await closed;
      gateway.onModuleDestroy();
      await new Promise<void>((resolve) => edge.close(() => resolve()));
    }
    // The proxied client may observe its close before the upstream viewer
    // releases input and detaches from the task app.
    await stopped;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(taskId, runId, expect.any(String));
  });
});
