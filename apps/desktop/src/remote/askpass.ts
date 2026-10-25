import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RemoteChallenge } from '@elevenex/shared';
import { failure } from './failure';

export type Ask = (challenge: RemoteChallenge, signal: AbortSignal) => Promise<string | null>;

/** A fresh, authenticated loopback broker belongs to one SSH attempt. */
export async function createAskpass(ask: Ask, interactive: boolean, signal: AbortSignal): Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<import('node:net').Socket>();
  let count = 0;
  let busy = false;
  const server = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== 'POST' || request.url !== '/' || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      response.writeHead(403).end(); request.resume(); return;
    }
    if (!interactive || busy || ++count > 16) { response.writeHead(403).end(); request.resume(); return; }
    busy = true;
    void respond(request, response).finally(() => { busy = false; });
  });
  async function respond(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      let prompt = '';
      for await (const chunk of request) {
        prompt += String(chunk);
        if (Buffer.byteLength(prompt) > 4096) throw new Error('Prompt too large');
      }
      // OpenSSH supplies its actual fingerprint for the trust confirmation.
      const trust = /Are you sure you want to continue connecting/i.test(prompt);
      const challenge: RemoteChallenge = {
        id: randomUUID(), kind: trust ? 'trust' : 'credential',
        prompt: [...prompt].filter(char => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, 4096), expiresAt: Date.now() + 120_000,
      };
      if (trust && !/SHA256:[A-Za-z0-9+/]+/.test(prompt)) throw failure('authentication', 'host-trust', 'SSH did not provide a host fingerprint. Verify this host in a terminal before connecting.', 'verify-host');
      const answer = await ask(challenge, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
      if (answer === null || signal.aborted || (trust && answer !== 'yes')) response.writeHead(403).end();
      else response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end(answer);
    } catch { if (!response.destroyed) response.writeHead(403).end(); }
  }
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Askpass listener is unavailable');
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { env: { ELEVENEX_ASKPASS_PORT: String(address.port), ELEVENEX_ASKPASS_TOKEN: token }, close };
}
