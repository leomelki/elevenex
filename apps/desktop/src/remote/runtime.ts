/** Uploaded as plain CommonJS alongside wire.js; runs only on the SSH host. */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect as connectSocket } from 'node:net';
import { createSocket } from 'node:dgram';
import { ForwardedAgentProxy } from './agent-proxy';
import { setTimeout as delay } from 'node:timers/promises';
import { Wire, SocketChannels, type WireMessage } from './wire';
import { queryDaemon, publishDaemon, verifyHealthRequest, healthResponseProof, type RuntimeHealth } from './runtime-control';

async function backendReady(socketPath: string, version: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const req = request({ socketPath, path: '/api/info', method: 'GET', signal }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('error', () => resolve(false));
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(body).backendSha === version); } catch { resolve(false); } });
    });
    const deadline = setTimeout(() => req.destroy(), 1000);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', () => resolve(false)); req.end();
  });
}

async function controlToken(root: string): Promise<string> {
  const path = join(root, 'control-token');
  try {
    const file = await open(path, 'wx', 0o600);
    const token = randomBytes(32).toString('hex');
    try { await file.writeFile(token); await file.sync(); } finally { await file.close(); }
    return token;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    // Another bridge may be finishing its first token write.
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await stat(path)).size <= 128) {
        const token = await readFile(path, 'utf8');
        if (/^[a-f0-9]{64}$/.test(token)) return token;
      }
      await delay(50);
    }
    throw new Error('EX11_CONFIGURATION: invalid daemon token file', { cause: error });
  }
}

async function daemon(root: string, installation: string, version: string, port: number, token: string): Promise<void> {
  const instance = randomUUID();
  const socketPath = join(root, 'backend.sock');
  let child: ChildProcess | undefined;
  let stopping = false;
  let ready = false;
  const lifetime = new AbortController();
  const agentPath = join(root, 'agent.sock');
  const agents = new ForwardedAgentProxy(agentPath);
  const health = createServer((req, res) => {
    const nonce = verifyHealthRequest(req, token);
    if (nonce === null) { res.writeHead(403).end(); return; }
    const lease = req.headers['x-elevenex-lease'];
    const agent = req.headers['x-elevenex-agent'];
    if (typeof lease === 'string' && /^[a-f0-9-]{36}$/.test(lease) && typeof agent === 'string' && agent.length <= 4096) {
      const path = Buffer.from(agent, 'base64').toString('utf8');
      agents.renew(lease, path.startsWith('/') && !path.includes('\0') && path.length <= 1024 ? path : null);
    }
    const body = JSON.stringify({ version, instance, ready });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Elevenex-Proof', healthResponseProof(token, nonce, body)); res.end(body);
  });
  health.requestTimeout = 2000; health.headersTimeout = 2000;
  // A separate UDP reservation can be retained by the supervisor without
  // accepting/swallowing any HTTP health connections in that other process.
  const ownership = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { ownership.once('error', reject); ownership.bind({ port, address: '127.0.0.1', exclusive: true }, resolve); });
  } catch (error) { ownership.close(); throw error; }
  try {
    await new Promise<void>((resolve, reject) => { health.once('error', reject); health.listen(0, '127.0.0.1', resolve); });
    const address = health.address();
    if (!address || typeof address === 'string') throw new Error('Invalid daemon listener');
    await publishDaemon(root, address.port, instance);
  } catch (error) {
    health.closeAllConnections();
    if (health.listening) await new Promise<void>(resolve => health.close(() => resolve()));
    ownership.close(); throw error;
  }
  try { await agents.listen(); }
  catch (error) {
    await agents.dispose(); health.closeAllConnections(); await new Promise<void>(resolve => health.close(() => resolve())); ownership.close(); throw error;
  }
  const stop = () => {
    if (stopping) return;
    stopping = true; ready = false; lifetime.abort();
    if (child?.connected) child.send({ type: 'stop' }, () => undefined); else child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const crashes: number[] = [];
  try {
    while (!stopping) {
      await rm(socketPath, { force: true });
      if (stopping) break;
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('ELEVENEX_') || key.startsWith('ELECTRON_') || ['NODE_OPTIONS', 'NODE_PATH', 'SSH_AUTH_SOCK'].includes(key)) delete env[key];
      }
      // Reuse the local backend's process lease. Daemon death closes its IPC
      // pipe, so a replacement daemon cannot leave an orphan database owner.
      child = fork(join(__dirname, 'host.js'), [join(installation, 'backend/main.cjs'), join(installation, 'backend'), '--ownership'], {
        execPath: process.execPath, execArgv: [], cwd: join(installation, 'backend'), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
          ...env, NODE_ENV: 'production', ELEVENEX_BACKEND_MODE: 'remote', ELEVENEX_BACKEND_SUPERVISED: '1',
          ELEVENEX_DATA_ROOT: join(root, 'data'), DB_PATH: join(root, 'data/elevenex.db'),
          ELEVENEX_BACKEND_RUNTIME_ROOT: join(installation, 'backend'), ELEVENEX_BIND_HOST: '127.0.0.1',
          ELEVENEX_DESKTOP_SOCKET: socketPath, ELEVENEX_PROXY_PORT: '11111', FRONTEND_PORT: '11111',
          SSH_AUTH_SOCK: agentPath,
        },
      });
      child.send({ type: 'ownership' }, ownership, { keepOpen: true }, () => undefined);
      let running = true;
      const monitoringLifetime = new AbortController();
      const monitoringSignal = AbortSignal.any([lifetime.signal, monitoringLifetime.signal]);
      const exited = new Promise<number | null>(resolve => {
        const finish = (code: number | null) => { running = false; ready = false; monitoringLifetime.abort(); resolve(code); };
        child?.once('error', () => finish(null)); child?.once('exit', finish);
      });
      const monitoring = (async () => {
        while (running && !stopping) {
          const current = await backendReady(socketPath, version, monitoringSignal);
          if (monitoringSignal.aborted) break;
          ready = current;
          // The backend can exit and unlink its socket during this probe.
          if (ready) await chmod(socketPath, 0o600).catch(() => { ready = false; });
          await delay(ready ? 1000 : 100, undefined, { signal: monitoringSignal }).catch(() => undefined);
        }
      })();
      const code = await exited;
      await monitoring;
      ready = false;
      if (stopping) break;
      const now = Date.now();
      while (crashes[0] !== undefined && crashes[0] < now - 60_000) crashes.shift();
      crashes.push(now);
      if (crashes.length > 3) break;
      await delay(code === 75 ? 0 : 500 * 2 ** (crashes.length - 1), undefined, { signal: lifetime.signal }).catch(() => undefined);
    }
  } finally {
    ready = false; health.closeAllConnections();
    // Keep the kernel lock until listener and path cleanup finishes. Otherwise
    // a new daemon can bind its sockets just before this daemon removes them.
    try {
      await Promise.all([
        agents.dispose(),
        new Promise<void>(resolve => health.close(() => resolve())),
      ]);
      await rm(socketPath, { force: true }); await rm(agentPath, { force: true });
    } finally { ownership.close(); }
  }
}

async function bridge(root: string, installation: string, version: string, port: number, token: string): Promise<void> {
  const lease = { id: randomUUID(), agent: process.env['SSH_AUTH_SOCK'] ?? null };
  let health: RuntimeHealth | undefined;
  let spawned = false;
  let starts = 0;
  const deadline = Date.now() + 45_000;
  while (!health?.ready) {
    if (health && health.version !== version) throw new Error('EX11_COMPATIBILITY: another desktop revision owns this remote backend; disconnect it and stop its daemon before upgrading');
    if (starts >= 16 && !health) throw new Error('EX11_CONFIGURATION: the remote daemon cannot acquire its ownership port or prepare its private sockets');
    if (Date.now() >= deadline) throw new Error('EX11_RUNTIME: backend did not become ready; check bundled Node compatibility and backend prerequisites');
    try { health = await queryDaemon(root, port, token, lease); }
    catch {
      health = undefined;
      // A stale TCP address can belong to another service. The independent UDP
      // lock, rather than TCP availability, authorizes starting a backend.
      if (!spawned) {
        spawned = true;
        starts++;
        const child = spawn(process.execPath, [__filename, 'daemon', root, installation, version], { cwd: root, detached: true, stdio: 'ignore', env: process.env });
        child.on('error', () => { spawned = false; }); child.on('exit', () => { spawned = false; }); child.unref();
      }
    }
    if (!health?.ready) await delay(health ? 100 : 250);
  }
  if (health.version !== version) throw new Error('EX11_COMPATIBILITY: remote backend revision differs');
  const wire = new Wire(process.stdin, process.stdout);
  const channels = new SocketChannels(wire);
  const socketPath = join(root, 'backend.sock');
  wire.on('message', (message: WireMessage) => {
    if (message.type === 'open') channels.accept(message.id, message.port, socketPath);
    else if (message.type === 'probe') {
      const socket = message.port === 0 ? connectSocket(socketPath) : connectSocket(message.port, '127.0.0.1');
      let done = false;
      const finish = (available: boolean) => {
        if (done) return; done = true; socket.destroy();
        wire.removeListener('closed', closed);
        try { wire.send({ type: 'probed', id: message.id, available }); } catch { /* Closed transport. */ }
      };
      const closed = () => finish(false);
      socket.setTimeout(3000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
      wire.once('closed', closed);
    }
    else if (message.type === 'ping') {
      void queryDaemon(root, port, token, lease).then(current => {
        wire.send({ type: 'pong', id: message.id, ready: current.ready && current.version === version, instance: current.instance });
      }).catch(() => wire.close());
    }
  });
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    channels.dispose(); wire.close(); process.stdin.destroy(); process.stdout.end();
    void queryDaemon(root, port, token, { id: lease.id, agent: null }).catch(() => undefined);
  };
  wire.once('closed', close); process.once('SIGTERM', close);
  wire.send({ type: 'hello', version, instance: health.instance, ready: true, agentForwarding: lease.agent !== null });
}

async function main(): Promise<void> {
  const [mode, root, installation, version] = process.argv.slice(2);
  if (!root || !installation || !version || !/^[a-f0-9]{40}$/.test(version)) throw new Error('EX11_CONFIGURATION: invalid remote runtime arguments');
  if (join(root, 'backend.sock').length > 100) throw new Error('EX11_COMPATIBILITY: remote home path is too long for a private backend socket');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
  const token = await controlToken(root);
  const port = 20000 + createHash('sha256').update(`${homedir()}:${process.getuid?.() ?? ''}:elevenex-desktop`).digest().readUInt32BE(0) % 20000;
  if (mode === 'daemon') await daemon(root, installation, version, port, token);
  else if (mode === 'bridge') await bridge(root, installation, version, port, token);
  else throw new Error('EX11_CONFIGURATION: unknown remote runtime mode');
}
void main().catch(error => {
  // Only our own fixed diagnostic markers leave the remote process.
  const message = error instanceof Error ? /EX11_[A-Z]+: [^\n]*/.exec(error.message)?.[0] : undefined;
  process.stderr.write(`${message ?? 'EX11_RUNTIME: remote runtime failed'}\n`); process.exitCode = 1;
});
