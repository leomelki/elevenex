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
    const notification = request.headers['x-elevenex-askpass-prompt'] === 'none';
    if (!interactive || !notification && busy || ++count > 16) { response.writeHead(403).end(); request.resume(); return; }
    // A hardware-key notification may coexist with its PIN prompt. Do not let
    // an informational message replace an active credential question.
    if (notification && busy) { response.writeHead(200).end(); request.resume(); return; }
    if (!notification) busy = true;
    void respond(request, response).finally(() => { if (!notification) busy = false; });
  });
  async function respond(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
    const lifetime = new AbortController();
    const closed = () => lifetime.abort();
    response.once('close', closed);
    try {
      let prompt = '';
      for await (const chunk of request) {
        prompt += String(chunk);
        if (Buffer.byteLength(prompt) > 4096) throw new Error('Prompt too large');
      }
      // OpenSSH supplies its actual fingerprint for the trust confirmation.
      const trust = /Are you sure you want to continue connecting/i.test(prompt);
      const hint = request.headers['x-elevenex-askpass-prompt'];
      const kind = trust ? 'trust' : hint === 'confirm' ? 'confirmation' : hint === 'none' ? 'notification' : 'credential';
      const challenge: RemoteChallenge = {
        id: randomUUID(), kind,
        prompt: [...prompt].filter(char => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, 4096), expiresAt: Date.now() + 120_000,
      };
      if (trust && !/(?:SHA256:[A-Za-z0-9+/]+|MD5:(?:[a-f0-9]{2}:){15}[a-f0-9]{2})/i.test(prompt)) throw failure('authentication', 'host-trust', 'SSH did not provide a host fingerprint. Verify this host in a terminal before connecting.', 'verify-host');
      const requestSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(120_000)]);
      const answer = await ask(challenge, requestSignal);
      if (response.destroyed) return;
      if (answer === null || requestSignal.aborted || (kind !== 'credential' && answer !== 'yes')) response.writeHead(403).end();
      else response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end(answer);
    } catch { if (!response.destroyed) response.writeHead(403).end(); }
    finally { response.removeListener('close', closed); }
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
