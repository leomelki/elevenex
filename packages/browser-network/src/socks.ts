import { createServer, createConnection, isIP, type Socket } from 'node:net';

export interface BrowserSocketTarget { readonly host: string; readonly port: number }
/** Private, task-owned SOCKS5 connector. No HTTP bodies, TLS bytes or page logs are inspected.
 * Browsers cannot speak the binary handshake through fetch/WebSocket to impersonate a proxy client. */
export async function browserSocks(resolve: (host: string, port: number) => Promise<BrowserSocketTarget>): Promise<{ readonly port: number; disconnect(): void; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer(client => {
    if (closing || sockets.size >= 128) { client.destroy(); return; }
    sockets.add(client);
    let buffer = Buffer.alloc(0), phase: 'hello' | 'connect' | 'connecting' | 'stream' = 'hello';
    let upstream: Socket | undefined;
    const deadline = setTimeout(() => client.destroy(), 5000);
    const close = () => {
      clearTimeout(deadline); sockets.delete(client); client.removeListener('data', data);
      upstream?.destroy();
    };
    client.once('close', close); client.on('error', () => client.destroy());
    const fail = () => {
      if (phase === 'stream') client.destroy(); else client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      upstream?.destroy();
    };
    const data = (chunk: Buffer) => {
      if (phase === 'connecting' || phase === 'stream') return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024) { client.destroy(); return; }
      if (phase === 'hello') {
        if (buffer.length < 2) return;
        const length = 2 + buffer[1]!;
        if (buffer.length < length) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) { client.destroy(); return; }
        buffer = buffer.subarray(length); phase = 'connect'; client.write(Buffer.from([5, 0]));
      }
      if (phase !== 'connect' || buffer.length < 4) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) { fail(); return; }
      let host: string, length: number;
      if (buffer[3] === 1) {
        length = 10; if (buffer.length < length) return;
        host = [...buffer.subarray(4, 8)].join('.');
      } else if (buffer[3] === 3) {
        if (buffer.length < 5) return;
        const count = buffer[4]!; length = 7 + count;
        if (!count || count > 253) { fail(); return; }
        if (buffer.length < length) return;
        host = buffer.subarray(5, 5 + count).toString('ascii');
        if (!/^[a-zA-Z0-9._-]+$/.test(host)) { fail(); return; }
      } else if (buffer[3] === 4) {
        length = 22; if (buffer.length < length) return;
        host = Array.from({ length: 8 }, (_, index) => buffer.readUInt16BE(4 + index * 2).toString(16)).join(':');
      } else { fail(); return; }
      const port = buffer.readUInt16BE(length - 2);
      if (!port || (buffer[3] !== 3 && !isIP(host))) { fail(); return; }
      const rest = buffer.subarray(length); buffer = Buffer.alloc(0);
      phase = 'connecting'; client.pause(); client.removeListener('data', data);
      void resolve(host, port).then(target => {
        if (closing || client.destroyed) return;
        if (sockets.size >= 128) { fail(); return; }
        upstream = createConnection({ host: target.host, port: target.port });
        sockets.add(upstream);
        const peer = upstream;
        peer.once('close', () => { sockets.delete(peer); client.destroy(); });
        peer.on('error', fail);
        peer.once('connect', () => {
          if (closing || client.destroyed) { peer.destroy(); return; }
          clearTimeout(deadline); phase = 'stream';
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) peer.write(rest);
          client.pipe(peer); peer.pipe(client); client.resume();
        });
      }).catch(fail);
    };
    client.on('data', data);
  });
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', no); yes(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not allocate task browser transport'); }
  return { port: address.port, disconnect: () => { for (const socket of sockets) socket.destroy(); sockets.clear(); }, close: async () => {
    if (closing) return;
    closing = true; for (const socket of sockets) socket.destroy(); sockets.clear();
    await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  } };
}
