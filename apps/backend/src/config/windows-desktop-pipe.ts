import { createServer as createTlsServer } from 'node:tls';
import { createServer, type Server as NetServer } from 'node:net';
import type { Server } from 'node:http';

function listen(server: NetServer, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, () => { server.off('error', reject); resolve(); });
  });
}

/** Keep a kernel-owned singleton for this data namespace before SQLite opens.
 * A prior daemon's backend may still be draining after a supervisor crash. */
export async function claimWindowsBackend(name: string) {
  if (!/^\\\\\.\\pipe\\elevenex-owner-[a-f0-9]{32}$/.test(name)) throw new Error('Invalid Windows runtime ownership pipe');
  const lock = createServer(socket => socket.destroy());
  await listen(lock, name);
  return lock;
}

/** Serve HTTP and WebSocket upgrades only after an authenticated TLS handshake.
 * Windows named-pipe addresses are discoverable and may be impersonated. */
export async function listenWindowsDesktop(server: Server, path: string, key: string) {
  if (!/^\\\\\.\\pipe\\elevenex-backend-[a-f0-9]{32}$/.test(path) || !/^[a-f0-9]{64}$/.test(key))
    throw new Error('Invalid Windows desktop pipe configuration');
  const transport = authenticatedDesktopTransport(server, key);
  await listen(transport, path);
  return transport;
}

export function authenticatedDesktopTransport(server: Server, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid Windows pipe credential');
  const secret = Buffer.from(key, 'hex');
  const transport = createTlsServer({
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'PSK-AES128-GCM-SHA256',
    handshakeTimeout: 5000,
    pskCallback: (_socket, identity) => identity === 'elevenex-bridge' ? secret : null,
  }, socket => server.emit('connection', socket));
  transport.maxConnections = 256;
  return transport;
}
