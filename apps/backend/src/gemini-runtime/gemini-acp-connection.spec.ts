import { PassThrough } from 'stream';
import {
  AcpConnection,
  describeAcpError,
  type AcpIncomingNotification,
  type AcpIncomingRequest,
} from './gemini-acp-connection.js';

function createConnection() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  const connection = new AcpConnection(stdin, stdout, 1_000);
  return { connection, stdout, written };
}

/** Frames the way gemini writes them: one JSON object per line. */
function frame(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

describe('AcpConnection framing', () => {
  it('sends JSON-RPC 2.0 requests and resolves the matching response', async () => {
    const { connection, stdout, written } = createConnection();

    const pending = connection.request('session/new', { cwd: '/repo' });
    await Promise.resolve();

    expect(written).toHaveLength(1);
    const sent = JSON.parse(written[0]) as Record<string, unknown>;
    // ACP is strict JSON-RPC 2.0, unlike the codex app-server.
    expect(sent['jsonrpc']).toBe('2.0');
    expect(sent['method']).toBe('session/new');
    expect(sent['id']).toBe(1);

    stdout.write(
      frame({ jsonrpc: '2.0', id: 1, result: { sessionId: 'abc' } }),
    );
    await expect(pending).resolves.toEqual({ sessionId: 'abc' });
  });

  it('reassembles messages split across chunk boundaries', async () => {
    const { connection, stdout } = createConnection();
    const notifications: AcpIncomingNotification[] = [];
    connection.on('notification', (n: AcpIncomingNotification) =>
      notifications.push(n),
    );

    const line = frame({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'plan' } },
    });
    stdout.write(line.slice(0, 20));
    stdout.write(line.slice(20));
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe('session/update');
  });

  it('strips the trailing CR that Windows shims introduce', async () => {
    const { connection, stdout } = createConnection();
    const notifications: AcpIncomingNotification[] = [];
    connection.on('notification', (n: AcpIncomingNotification) =>
      notifications.push(n),
    );

    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ping' })}\r\n`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications.map((n) => n.method)).toEqual(['ping']);
  });

  it('routes agent-to-client calls to `request`, not `notification`', async () => {
    const { connection, stdout } = createConnection();
    const requests: AcpIncomingRequest[] = [];
    const notifications: AcpIncomingNotification[] = [];
    connection.on('request', (r: AcpIncomingRequest) => requests.push(r));
    connection.on('notification', (n: AcpIncomingNotification) =>
      notifications.push(n),
    );

    // Carries both an id and a method: it must be answered.
    stdout.write(
      frame({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { sessionId: 's' },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(requests).toHaveLength(1);
    expect(requests[0].id).toBe(7);
    expect(notifications).toHaveLength(0);
  });

  it('rejects a pending request when the response carries an error', async () => {
    const { connection, stdout } = createConnection();
    const pending = connection.request('session/prompt', {});
    await Promise.resolve();

    stdout.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Gemini API key is missing.' },
      }),
    );

    await expect(pending).rejects.toThrow('Gemini API key is missing.');
  });

  it('rejects every in-flight request when the connection closes', async () => {
    const { connection } = createConnection();
    const pending = connection.request('session/prompt', {});
    await Promise.resolve();

    connection.close(new Error('process exited'));

    await expect(pending).rejects.toThrow('process exited');
    expect(connection.isClosed).toBe(true);
  });

  it('ignores non-protocol noise on stdout instead of dying', async () => {
    const { connection, stdout } = createConnection();
    const noise: string[] = [];
    const notifications: AcpIncomingNotification[] = [];
    connection.on('noise', (line: string) => noise.push(line));
    connection.on('notification', (n: AcpIncomingNotification) =>
      notifications.push(n),
    );

    stdout.write('Warning: 256-color support not detected.\n');
    stdout.write(frame({ jsonrpc: '2.0', method: 'ping' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(noise).toHaveLength(1);
    expect(notifications.map((n) => n.method)).toEqual(['ping']);
  });
});

describe('describeAcpError', () => {
  it('unwraps the JSON that gemini nests inside error.message', () => {
    // Real shape observed from gemini-cli 0.55.1 on an invalid API key.
    const error = {
      code: 400,
      message: JSON.stringify({
        error: {
          message: JSON.stringify({
            error: { code: 400, message: 'API key not valid.' },
          }),
          code: 400,
        },
      }),
    };

    expect(describeAcpError(error, 'session/prompt')).toBe(
      'API key not valid.',
    );
  });

  it('passes a plain message through untouched', () => {
    expect(describeAcpError({ message: 'boom' }, 'session/new')).toBe('boom');
  });

  it('falls back to naming the method when there is no message', () => {
    expect(describeAcpError(null, 'session/new')).toContain('session/new');
  });
});
