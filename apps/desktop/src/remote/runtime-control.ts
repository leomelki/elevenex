/** Private remote daemon discovery/authentication; uploaded with runtime.js. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';

export interface RuntimeHealth {
  version: string;
  instance: string;
  ready: boolean;
  /** Absent on daemons predating authenticated handoff and instance sockets. */
  handoff?: 1;
  replacement?: string;
}
export interface RuntimeLease { id: string; agent: string | null }
const mac = (token: string, value: string) => createHmac('sha256', token).update(value).digest('hex');
export function sameProof(value: unknown, expected: string): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
export function healthResponseProof(token: string, nonce: string, body: string): string { return mac(token, `response:${nonce}:${body}`); }

/** No bearer secret is sent to a stale port that another remote user may own. */
export function verifyHealthRequest(req: IncomingMessage, token: string): string | null {
  const time = req.headers['x-elevenex-time']; const nonce = req.headers['x-elevenex-nonce'];
  const lease = req.headers['x-elevenex-lease'] ?? ''; const agent = req.headers['x-elevenex-agent'] ?? '';
  if (req.method !== 'GET' || req.url !== '/health' || typeof time !== 'string' || !/^\d{13}$/.test(time)
    || Math.abs(Date.now() - Number(time)) > 10_000 || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)
    || typeof lease !== 'string' || typeof agent !== 'string') return null;
  return sameProof(req.headers['x-elevenex-proof'], mac(token, `request:${time}:${nonce}:${lease}:${agent}`)) ? nonce : null;
}

/** Bind a destructive request to one instance and one source/target revision. */
export function verifyHandoffRequest(req: IncomingMessage, token: string, current: RuntimeHealth): { nonce: string; target: string } | null {
  const time = req.headers['x-elevenex-time']; const nonce = req.headers['x-elevenex-nonce'];
  const instance = req.headers['x-elevenex-instance']; const version = req.headers['x-elevenex-version']; const target = req.headers['x-elevenex-target'];
  if (req.method !== 'POST' || req.url !== '/handoff' || typeof time !== 'string' || !/^\d{13}$/.test(time)
    || Math.abs(Date.now() - Number(time)) > 10_000 || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)
    || instance !== current.instance || version !== current.version || typeof target !== 'string' || !/^[a-f0-9]{40}$/.test(target) || target === version) return null;
  return sameProof(req.headers['x-elevenex-proof'], mac(token, `handoff:${time}:${nonce}:${instance}:${version}:${target}`)) ? { nonce, target } : null;
}

/** A retired bridge must never open the replacement backend's socket. */
export function backendSocketPath(root: string, health: Pick<RuntimeHealth, 'instance' | 'handoff'>): string {
  return join(root, health.handoff === 1 ? `b-${createHash('sha256').update(health.instance).digest('hex').slice(0, 16)}` : 'backend.sock');
}

export async function publishDaemon(root: string, port: number, instance: string): Promise<void> {
  const temporary = join(root, `.daemon-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ port, instance }), { mode: 0o600 });
    await rename(temporary, join(root, 'daemon.json'));
  } finally { await rm(temporary, { force: true }); }
}

async function daemonAddress(root: string, fallbackPort: number): Promise<{ port: number; instance?: string }> {
  let port = fallbackPort; let expectedInstance: string | undefined;
  try {
    const path = join(root, 'daemon.json'); const info = await stat(path);
    if (!info.isFile() || info.size > 1024) throw new Error('Invalid daemon discovery file');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('port' in value) || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || !('instance' in value) || typeof value.instance !== 'string' || value.instance.length > 64) throw new Error('Invalid daemon discovery file');
    port = value.port; expectedInstance = value.instance;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  return { port, instance: expectedInstance };
}

async function controlRequest(root: string, fallbackPort: number, token: string, nonce: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>): Promise<RuntimeHealth> {
  const { port, instance: expectedInstance } = await daemonAddress(root, fallbackPort);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.on('data', (bytes: Buffer) => { data += bytes; if (data.length > 4096) req.destroy(new Error('Invalid daemon reply')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200 || !sameProof(res.headers['x-elevenex-proof'], healthResponseProof(token, nonce, data))) throw new Error('Daemon identity could not be verified');
          const value: unknown = JSON.parse(data);
          if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string' || !/^[a-f0-9]{40}$/.test(value.version)
            || !('instance' in value) || typeof value.instance !== 'string' || value.instance.length > 64
            || expectedInstance !== undefined && value.instance !== expectedInstance || !('ready' in value) || typeof value.ready !== 'boolean'
            || 'handoff' in value && value.handoff !== 1
            || 'replacement' in value && (typeof value.replacement !== 'string' || !/^[a-f0-9]{40}$/.test(value.replacement))) throw new Error('Invalid daemon reply');
          resolve({ version: value.version, instance: value.instance, ready: value.ready,
            ...('handoff' in value ? { handoff: 1 as const } : {}),
            ...('replacement' in value && typeof value.replacement === 'string' ? { replacement: value.replacement } : {}),
          });
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Daemon control timed out')), 2000);
    req.once('close', () => clearTimeout(deadline)); req.once('error', reject); req.end();
  });
}

export async function queryDaemon(root: string, fallbackPort: number, token: string, lease?: RuntimeLease): Promise<RuntimeHealth> {
  const nonce = randomBytes(32).toString('hex'); const time = String(Date.now());
  const leaseId = lease?.id ?? ''; const agent = Buffer.from(lease?.agent ?? '').toString('base64');
  return controlRequest(root, fallbackPort, token, nonce, 'GET', '/health', {
    'X-Elevenex-Time': time, 'X-Elevenex-Nonce': nonce, 'X-Elevenex-Lease': leaseId, 'X-Elevenex-Agent': agent,
    'X-Elevenex-Proof': mac(token, `request:${time}:${nonce}:${leaseId}:${agent}`),
  });
}

export async function requestHandoff(root: string, fallbackPort: number, token: string, current: RuntimeHealth, target: string): Promise<RuntimeHealth> {
  const nonce = randomBytes(32).toString('hex'); const time = String(Date.now());
  return controlRequest(root, fallbackPort, token, nonce, 'POST', '/handoff', {
    'X-Elevenex-Time': time, 'X-Elevenex-Nonce': nonce, 'X-Elevenex-Instance': current.instance,
    'X-Elevenex-Version': current.version, 'X-Elevenex-Target': target,
    'X-Elevenex-Proof': mac(token, `handoff:${time}:${nonce}:${current.instance}:${current.version}:${target}`),
  });
}
