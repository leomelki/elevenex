import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { authenticatedDesktopTransport, claimWindowsBackend } from './windows-desktop-pipe.js';

const windowsOnly = process.platform === 'win32' ? it : it.skip;
windowsOnly('holds exclusive ownership until the previous Windows backend releases its kernel handle', async () => {
  const name = '\\\\.\\pipe\\elevenex-owner-' + randomBytes(16).toString('hex');
  const owner = await claimWindowsBackend(name);
  try {
    await expect(claimWindowsBackend(name)).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => owner.close(() => resolve()));
  }
  const replacement = await claimWindowsBackend(name);
  await new Promise<void>(resolve => replacement.close(() => resolve()));
});

it('authenticates both pipe peers before dispatching a backend HTTP request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backend-pipe-'));
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\elevenex-test-' + randomBytes(16).toString('hex') : join(directory, 'socket');
  const expected = randomBytes(32).toString('hex');
  let requests = 0;
  const backend = createServer((_req, res) => { requests++; res.end('ready'); });
  const server = authenticatedDesktopTransport(backend, expected);
  const call = (key: string) => new Promise<string>((resolve, reject) => {
    const req = request({
      socketPath: path, signal: AbortSignal.timeout(3000),
      createConnection: () => connect({
        path, ciphers: 'PSK-AES128-GCM-SHA256', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        rejectUnauthorized: false, pskCallback: () => ({ identity: 'elevenex-bridge', psk: Buffer.from(key, 'hex') }),
      }),
    }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(text));
    });
    req.once('error', reject); req.end();
  });
  try {
    server.listen(path); await once(server, 'listening');
    await expect(call(randomBytes(32).toString('hex'))).rejects.toThrow();
    expect(requests).toBe(0);
    await expect(call(expected)).resolves.toBe('ready');
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
