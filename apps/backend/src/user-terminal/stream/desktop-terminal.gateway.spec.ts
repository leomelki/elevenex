import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createEdgeProxyServer } from '../../proxy/edge-proxy.server.js';
import { DesktopTerminalStream } from '../desktop-terminal-stream.js';
import { DesktopTerminalGateway, terminalStreamAuthorized } from './desktop-terminal.gateway.js';

const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Terminal stream condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
interface Packet { type: string; delivery?: number; output?: { data: string }; sequence?: number; writable?: boolean; message?: string; uncertain?: boolean }

async function setup(mode: 'direct' | 'local' | 'upstream' = 'direct') {
  const stream = new DesktopTerminalStream(); stream.append('$ ');
  const commands: string[] = [];
  let hold: Promise<void> | undefined;
  const terminal = () => ({ id: 2, taskId: 1, title: 'bash', cwd: '/task', branch: 'work', generation: stream.generation,
    sequence: stream.sequence, alive: true, status: 'idle', command: '', exitCode: 0, port: null, canRerun: false });
  const service = {
    attach: jest.fn(async () => ({ stream, current: () => true, refresh: async () => {}, read: (gen: string | null, after: number) => ({ terminal: terminal(), ...stream.read(gen, after) }),
      snapshot: async () => ({ sequence: stream.sequence, cols: 80, rows: 24, data: '$ ' }),
    })),
    list: async () => ({ taskId: 1, terminals: [terminal()], scripts: [], limit: 16, streamVersion: 1 }),
    command: jest.fn(async (_task: number, _id: number, input: Record<string, unknown>) => {
      await hold;
      if (typeof input.data === 'string') { commands.push(input.data); stream.append(input.data); }
      return { accepted: true };
    }),
  };
  const gateway = new DesktopTerminalGateway(service as never), server = createServer();
  gateway.attachToServer(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const backendAddress = server.address();
  if (!backendAddress || typeof backendAddress === 'string')
    throw new Error('No server address');
  const proxy =
    mode === 'direct'
      ? undefined
      : createEdgeProxyServer({
          repoRoot: join(__dirname, '../../../../..'),
          ...(mode === 'local'
            ? { localHttpServer: server }
            : { upstreamOrigin: `http://127.0.0.1:${backendAddress.port}` }),
        });
  if (proxy)
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = (proxy ?? server).address();
  if (!address || typeof address === 'string')
    throw new Error('No stream address');
  const sockets: WebSocket[] = [];
  async function connect(autoAck = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}/desktop-terminal/v1?taskId=1&terminalId=2&after=0`);
    sockets.push(ws);
    const packets: Packet[] = [];
    ws.on('message', data => {
      const value: Packet = JSON.parse(data.toString()); packets.push(value);
      if (autoAck && value.delivery) ws.send(JSON.stringify({ type: 'ack', delivery: value.delivery }));
    });
    await until(() => packets.some(packet => packet.type === 'snapshot'));
    return { ws, packets };
  }
  return { stream, commands, service, connect, hold: (promise: Promise<void>) => { hold = promise; }, close: async () => {
    for (const socket of sockets) socket.terminate(); gateway.onModuleDestroy();
    if (proxy)
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

describe('Desktop terminal bidirectional protocol', () => {
  it.each(['direct', 'local', 'upstream'] as const)(
    'pushes output and accepts pipelined input independently of acknowledgements via %s',
    async (mode) => {
      const fixture = await setup(mode);
      try {
        const { ws, packets } = await fixture.connect();
        let release!: () => void;
        fixture.hold(new Promise((resolve) => { release = resolve; }));
        for (const [index, data] of ['a', 'b'].entries()) {
          ws.send(JSON.stringify({ type: 'input', kind: 'text', sequence: index + 1, generation: fixture.stream.generation, data }));
        }
        await until(() => fixture.service.command.mock.calls.length === 1);
        expect(packets.some(packet => packet.type === 'input-ack')).toBe(false);
        release();
        await until(() => fixture.commands.length === 2);
        expect(fixture.commands).toEqual(['a', 'b']);
        await until(() => packets.some(packet => packet.type === 'input-ack' && packet.sequence === 2));
        fixture.stream.append('pushed');
        await until(() => packets.some(packet => packet.output?.data.includes('pushed')));
        expect(fixture.service.attach).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.close();
      }
    },
  );
  it('bounds a stalled consumer and transfers input/resize ownership without stopping the process', async () => {
    const fixture = await setup();
    try {
      const first = await fixture.connect(false);
      fixture.stream.append('x'.repeat(200000));
      await until(() => first.packets.filter(packet => packet.type === 'output').length >= 3);
      const characters = first.packets.reduce((count, packet) => count + (packet.output?.data.length ?? 0), 0);
      expect(characters).toBeLessThanOrEqual(160 * 1024);
      const second = await fixture.connect();
      await until(() => first.packets.some(packet => packet.type === 'control' && packet.writable === false));
      fixture.stream.append('still-live');
      await until(() => second.packets.some(packet => packet.output?.data.includes('still-live')));
      const delivery = Math.max(...first.packets.map(packet => packet.delivery ?? 0));
      first.ws.send(JSON.stringify({ type: 'ack', delivery }));
      await until(() => first.packets.some(packet => packet.output?.data.includes('still-live')));
    } finally { await fixture.close(); }
  });
  it('rejects out-of-order input without executing or replaying it', async () => {
    const fixture = await setup();
    try {
      const { ws } = await fixture.connect();
      ws.send(JSON.stringify({ type: 'input', kind: 'text', sequence: 2, generation: fixture.stream.generation, data: 'never' }));
      await until(() => ws.readyState === WebSocket.CLOSED);
      expect(fixture.commands).toEqual([]);
    } finally { await fixture.close(); }
  });
  it('ignores obsolete resizes after focus moves without disconnecting output', async () => {
    const fixture = await setup();
    try {
      const first = await fixture.connect();
      await fixture.connect();
      await until(() => first.packets.some(packet => packet.type === 'control' && packet.writable === false));
      first.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
      fixture.stream.append('retained observer');
      await until(() => first.packets.some(packet => packet.output?.data.includes('retained observer')));
      expect(first.ws.readyState).toBe(WebSocket.OPEN);
      expect(fixture.service.command).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });
  it.each(['resize', 'input'] as const)('reports a rejected %s once and flags only pending input as uncertain', async type => {
    const fixture = await setup();
    try {
      const { ws, packets } = await fixture.connect();
      fixture.service.command.mockRejectedValue(new Error('Command rejected'));
      const command = type === 'resize' ? { type, cols: 90, rows: 20 }
        : { type, kind: 'text', sequence: 1, generation: fixture.stream.generation, data: 'never replay' };
      ws.send(JSON.stringify(command));
      await until(() => ws.readyState === WebSocket.CLOSED);
      const closed = packets.filter(packet => packet.type === 'closed');
      expect(closed).toHaveLength(1);
      expect(closed[0].uncertain).toBe(type === 'input');
      expect(closed[0].message).toContain(type === 'input' ? 'keystrokes' : 'connection lost');
      expect(fixture.commands).toEqual([]);
    } finally { await fixture.close(); }
  });
  it('rejects browser origins and enforces the private desktop capability', () => {
    const saved = process.env.ELEVENEX_CODE_ACCESS;
    process.env.ELEVENEX_CODE_ACCESS = 'a'.repeat(64);
    try {
      const request = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as never;
      expect(terminalStreamAuthorized(request({}))).toBe(false);
      expect(terminalStreamAuthorized(request({ 'x-elevenex-code-access': 'é'.repeat(64) }))).toBe(false);
      expect(terminalStreamAuthorized(request({ 'x-elevenex-code-access': 'a'.repeat(64) }))).toBe(true);
      expect(terminalStreamAuthorized(request({ origin: 'http://127.0.0.1', 'x-elevenex-code-access': 'a'.repeat(64) }))).toBe(false);
      expect(terminalStreamAuthorized(request({ 'sec-fetch-site': 'none', 'x-elevenex-code-access': 'a'.repeat(64) }))).toBe(false);
    } finally { if (saved === undefined) delete process.env.ELEVENEX_CODE_ACCESS; else process.env.ELEVENEX_CODE_ACCESS = saved; }
  });
});
