/** Private remote daemon discovery/authentication; uploaded with runtime.js. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { basename, dirname, join } from 'node:path';

export function ownershipPort(root: string, home: string, uid: number | undefined): number {
  const namespace = basename(root);
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(root.toLowerCase()).digest().readUInt32BE(0);
    return 20000 + hash % 20000;
  }
  const development = dirname(root) === join(home, '.elevenex', 'desktop-remote-dev') && /^[a-f0-9]{32}$/.test(namespace);
  const hash = createHash('sha256').update(`${home}:${uid ?? ''}:elevenex-desktop${development ? `:${namespace}` : ''}`).digest().readUInt32BE(0);
  return development ? 10000 + hash % 10000 : 20000 + hash % 20000;
}

export interface RuntimeHealth {
  version: string;
  instance: string;
  ready: boolean;
  /** Absent on daemons predating authenticated handoff and instance sockets. */
  handoff?: 1;
  activeConnections?: number;
  appHandoffBlocked?: true;
  replacement?: string;
  /** Windows daemon started without a desktop session; absent means the desktop session. */
  session?: 'background';
}
/** The daemon waits this long for its backend to stop apps before a handoff. */
export const APP_HANDOFF_LIMIT_MS = 25_000;
export interface RuntimeLease { id: string; agent: string | null; presence?: 'active' | 'closed'; instance?: string }
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
export function verifyHandoffRequest(req: IncomingMessage, token: string, current: RuntimeHealth): { nonce: string; target: string; force?: true } | null {
  const time = req.headers['x-elevenex-time']; const nonce = req.headers['x-elevenex-nonce'];
  const instance = req.headers['x-elevenex-instance']; const version = req.headers['x-elevenex-version']; const target = req.headers['x-elevenex-target'];
  const force = req.headers['x-elevenex-force'];
  if (req.method !== 'POST' || req.url !== '/handoff' || typeof time !== 'string' || !/^\d{13}$/.test(time)
    || Math.abs(Date.now() - Number(time)) > 10_000 || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)
    || instance !== current.instance || version !== current.version || typeof target !== 'string' || !/^[a-f0-9]{40}$/.test(target) || target === version
    || (force !== undefined && force !== '1')) return null;
  return sameProof(req.headers['x-elevenex-proof'], mac(token, `handoff:${time}:${nonce}:${instance}:${version}:${target}${force ? ':force' : ''}`))
    ? { nonce, target, ...(force ? { force: true as const } : {}) } : null;
}

/** Bind a request to stop a background daemon to that one instance and revision. */
export function verifySessionRequest(req: IncomingMessage, token: string, current: RuntimeHealth): string | null {
  const time = req.headers['x-elevenex-time']; const nonce = req.headers['x-elevenex-nonce'];
  const instance = req.headers['x-elevenex-instance']; const version = req.headers['x-elevenex-version'];
  if (req.method !== 'POST' || req.url !== '/session' || typeof time !== 'string' || !/^\d{13}$/.test(time)
    || Math.abs(Date.now() - Number(time)) > 10_000 || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)
    || instance !== current.instance || version !== current.version) return null;
  return sameProof(req.headers['x-elevenex-proof'], mac(token, `session:${time}:${nonce}:${instance}:${version}`)) ? nonce : null;
}

export function connectionPresence(req: IncomingMessage, token: string, nonce: string, id: string, instance: string): RuntimeLease['presence'] | null {
  const presence = req.headers['x-elevenex-presence'];
  if (presence === undefined) return undefined;
  return (presence === 'active' || presence === 'closed') && sameProof(req.headers['x-elevenex-presence-proof'], mac(token, `presence:${nonce}:${id}:${presence}:${instance}`)) ? presence : null;
}

/** A retired bridge must never open the replacement backend's socket. */
export function backendSocketPath(root: string, health: Pick<RuntimeHealth, 'instance' | 'handoff'>): string {
  if (process.platform === 'win32') {
    const id = createHash('sha256').update(root + ':' + health.instance).digest('hex').slice(0, 32);
    return '\\\\.\\pipe\\elevenex-backend-' + id;
  }
  return join(root, health.handoff === 1 ? `b-${createHash('sha256').update(health.instance).digest('hex').slice(0, 16)}` : 'backend.sock');
}

export async function publishDaemon(root: string, port: number, instance: string, ownershipPort?: number): Promise<void> {
  const temporary = join(root, `.daemon-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ port, instance, ownershipPort }), { mode: 0o600 });
    await rename(temporary, join(root, 'daemon.json'));
  } finally { await rm(temporary, { force: true }); }
}

export async function needsLegacyOwnership(root: string, port: number): Promise<boolean> {
  try {
    const path = join(root, 'daemon.json');
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024) return true;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return !value || typeof value !== 'object' || !('ownershipPort' in value) || value.ownershipPort !== port;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
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

async function controlRequest(root: string, fallbackPort: number, token: string, nonce: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>, limit = 2000): Promise<RuntimeHealth> {
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
            || 'appHandoffBlocked' in value && value.appHandoffBlocked !== true
            || 'activeConnections' in value && (typeof value.activeConnections !== 'number' || !Number.isInteger(value.activeConnections) || value.activeConnections < 0 || value.activeConnections > 257)
            || 'replacement' in value && (typeof value.replacement !== 'string' || !/^[a-f0-9]{40}$/.test(value.replacement))
            || 'session' in value && value.session !== 'background') throw new Error('Invalid daemon reply');
          resolve({ version: value.version, instance: value.instance, ready: value.ready,
            ...('handoff' in value ? { handoff: 1 as const } : {}),
            ...('appHandoffBlocked' in value ? { appHandoffBlocked: true as const } : {}),
            ...('activeConnections' in value && typeof value.activeConnections === 'number' ? { activeConnections: value.activeConnections } : {}),
            ...('replacement' in value && typeof value.replacement === 'string' ? { replacement: value.replacement } : {}),
            ...('session' in value ? { session: 'background' as const } : {}),
          });
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Daemon control timed out')), limit);
    req.once('close', () => clearTimeout(deadline)); req.once('error', reject); req.end();
  });
}

export async function queryDaemon(root: string, fallbackPort: number, token: string, lease?: RuntimeLease): Promise<RuntimeHealth> {
  const nonce = randomBytes(32).toString('hex'); const time = String(Date.now());
  const leaseId = lease?.id ?? ''; const agent = Buffer.from(lease?.agent ?? '').toString('base64');
  return controlRequest(root, fallbackPort, token, nonce, 'GET', '/health', {
    'X-Elevenex-Time': time, 'X-Elevenex-Nonce': nonce, 'X-Elevenex-Lease': leaseId, 'X-Elevenex-Agent': agent,
    'X-Elevenex-Proof': mac(token, `request:${time}:${nonce}:${leaseId}:${agent}`),
    ...(lease?.presence ? { 'X-Elevenex-Presence': lease.presence, 'X-Elevenex-Presence-Proof': mac(token, `presence:${nonce}:${leaseId}:${lease.presence}:${lease.instance}`) } : {}),
  });
}

export async function requestHandoff(root: string, fallbackPort: number, token: string, current: RuntimeHealth, target: string, force = false): Promise<RuntimeHealth> {
  const nonce = randomBytes(32).toString('hex'); const time = String(Date.now());
  const signedForce = force && current.activeConnections !== undefined;
  return controlRequest(root, fallbackPort, token, nonce, 'POST', '/handoff', {
    'X-Elevenex-Time': time, 'X-Elevenex-Nonce': nonce, 'X-Elevenex-Instance': current.instance,
    'X-Elevenex-Version': current.version, 'X-Elevenex-Target': target,
    'X-Elevenex-Proof': mac(token, `handoff:${time}:${nonce}:${current.instance}:${current.version}:${target}${signedForce ? ':force' : ''}`),
    ...(signedForce ? { 'X-Elevenex-Force': '1' } : {}),
  }, APP_HANDOFF_LIMIT_MS + 5000);
}

/** Ask a background daemon to stop so the desktop-session runtime can take over. */
export async function requestDesktopSession(root: string, fallbackPort: number, token: string, current: RuntimeHealth): Promise<RuntimeHealth> {
  const nonce = randomBytes(32).toString('hex'); const time = String(Date.now());
  return controlRequest(root, fallbackPort, token, nonce, 'POST', '/session', {
    'X-Elevenex-Time': time, 'X-Elevenex-Nonce': nonce, 'X-Elevenex-Instance': current.instance, 'X-Elevenex-Version': current.version,
    'X-Elevenex-Proof': mac(token, `session:${time}:${nonce}:${current.instance}:${current.version}`),
  });
}
