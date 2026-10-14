import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { DesktopPortForwardingGateway } from './desktop-port-forwarding.gateway.js';

const response = { forwards: [], total: 0, nextOffset: null };
const signal = () => new AbortController().signal;
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return once(ws, 'message').then(
    ([raw]: [Buffer]) =>
      JSON.parse(raw.toString('utf8')) as Record<string, unknown>,
  );
}

describe('DesktopPortForwardingGateway', () => {
  let gateway: DesktopPortForwardingGateway;
  let server: Server;
  let url: string;
  let sockets: WebSocket[];
  beforeEach(async () => {
    sockets = [];
    gateway = new DesktopPortForwardingGateway();
    server = createServer();
    gateway.attachToServer(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/desktop-port-forwarding`;
  });
  afterEach(async () => {
    jest.useRealTimers();
    gateway.onModuleDestroy();
    for (const ws of sockets) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function desktop(desktopId = 'desktop-a', windowId = 'w1') {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await once(ws, 'open');
    const ready = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'register',
        context: {
          desktopId,
          windowId,
          mode: 'ssh',
          connectionLabel: 'Dev server',
          defaultConnection: 'ssh',
        },
      }),
    );
    expect(await ready).toEqual({ type: 'ready' });
    return ws;
  }

  it('fails promptly when no desktop is available', async () => {
    await expect(
      gateway.request('create', { projectId: 5 }, signal()),
    ).rejects.toMatchObject({ code: 'desktop_unavailable', retryable: true });
  });
  it('routes a mutation to one window and ignores replies from other windows', async () => {
    const first = await desktop();
    const second = await desktop('desktop-a', 'w2');
    expect(gateway.desktops()).toHaveLength(1);
    const receive = nextMessage(first);
    const pending = gateway.request(
      'create',
      { projectId: 5, remotePort: 5173 },
      signal(),
    );
    const message = await receive;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    second.send(
      JSON.stringify({ type: 'response', id: message.id, data: response }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    first.send(
      JSON.stringify({ type: 'response', id: message.id, data: response }),
    );
    expect(await pending).toMatchObject({
      ...response,
      desktop: { desktopId: 'desktop-a', windowId: 'w1' },
    });
  });
  it('requires a choice between distinct desktops and respects an explicit selection', async () => {
    await desktop();
    const chosen = await desktop('desktop-b');
    await expect(
      gateway.request('start', { projectId: 5 }, signal()),
    ).rejects.toMatchObject({
      code: 'desktop_required',
      details: { desktops: expect.any(Array) as unknown },
    });
    const receive = nextMessage(chosen);
    const pending = gateway.request(
      'list',
      { projectId: 5 },
      signal(),
      'desktop-b',
    );
    const request = await receive;
    chosen.send(
      JSON.stringify({ type: 'response', id: request.id, data: response }),
    );
    expect(await pending).toMatchObject({
      desktop: { desktopId: 'desktop-b' },
    });
  });
  it('cancels pending work and ignores late responses', async () => {
    const ws = await desktop();
    const controller = new AbortController();
    const receive = nextMessage(ws);
    const pending = gateway.request(
      'create',
      { projectId: 5 },
      controller.signal,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
    });
    const request = await receive;
    const cancel = nextMessage(ws);
    controller.abort();
    await rejection;
    expect(await cancel).toEqual({ type: 'cancel', id: request.id });
    ws.send(
      JSON.stringify({ type: 'response', id: request.id, data: response }),
    );
  });
  it('bounds waits and tells the caller to inspect accepted work', async () => {
    const ws = await desktop();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const receive = nextMessage(ws);
    const pending = gateway.request('start', { projectId: 5 }, signal());
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'desktop_timeout',
      remediation: expect.stringContaining('before retrying') as unknown,
    });
    await receive;
    jest.advanceTimersByTime(45_000);
    await rejection;
  });
  it('rejects on disconnect without replaying a mutation on another window', async () => {
    const first = await desktop();
    await desktop('desktop-a', 'w2');
    const receive = nextMessage(first);
    const pending = gateway.request('stop', { projectId: 5 }, signal());
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'desktop_disconnected',
    });
    await receive;
    first.close();
    await rejection;
  });
  it('validates desktop responses and returns actionable runtime errors', async () => {
    const ws = await desktop();
    for (const reply of [
      { data: { forwards: 'invalid' } },
      { error: 'Local port 5173 is already in use.' },
    ]) {
      const receive = nextMessage(ws);
      const pending = gateway.request('start', { projectId: 5 }, signal());
      const rejection = expect(pending).rejects.toMatchObject({
        code:
          'error' in reply ? 'port_forward_failed' : 'invalid_desktop_response',
      });
      const request = await receive;
      ws.send(JSON.stringify({ type: 'response', id: request.id, ...reply }));
      await rejection;
    }
  });
});
