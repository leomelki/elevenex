import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Exercise the complete remote entry point, migrations and revision probe. */
export async function verifyRemoteBackend(directory, executable, version, signal = AbortSignal.timeout(30000)) {
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('Invalid smoke-test backend revision');
  const root = await mkdtemp('/tmp/ex-smoke-');
  let child;
  let closed;
  let output = '';
  const socketPath = join(root, 'backend.sock');
  const polling = new AbortController();
  signal = AbortSignal.any([signal, polling.signal]);
  try {
    const data = join(root, 'data');
    await mkdir(data);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('ELEVENEX_') || key.startsWith('ELECTRON_') || ['NODE_OPTIONS', 'NODE_PATH', 'DB_PATH', 'SSH_AUTH_SOCK'].includes(key)) delete env[key];
    }
    signal.throwIfAborted();
    child = spawn(executable, [join(directory, 'main.cjs')], {
      cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...env, HOME: root, NODE_ENV: 'production', ELEVENEX_BACKEND_MODE: 'remote', ELEVENEX_BACKEND_SUPERVISED: '1',
        ELEVENEX_DATA_ROOT: data, DB_PATH: join(data, 'elevenex.db'), ELEVENEX_BACKEND_RUNTIME_ROOT: directory,
        ELEVENEX_DESKTOP_SOCKET: socketPath, ELEVENEX_BIND_HOST: '127.0.0.1', ELEVENEX_PROXY_PORT: '11111', FRONTEND_PORT: '11111',
      },
    });
    const capture = bytes => { output = (output + bytes.toString('utf8')).slice(-16384); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    closed = new Promise(resolve => child.once('close', resolve));
    const failed = new Promise((_, reject) => {
      child.once('error', reject);
      child.once('close', code => reject(new Error(`Remote backend smoke test exited (${code}).`)));
    });
    const ready = async () => {
      while (true) {
        signal.throwIfAborted();
        const revision = await new Promise(resolve => {
          const req = request({ socketPath, path: '/api/info', signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) }, res => {
            let body = '';
            res.on('data', bytes => { body += bytes; if (body.length > 4096) req.destroy(); });
            res.once('error', () => resolve(null));
            res.once('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body).backendSha : null); } catch { resolve(null); } });
          });
          req.once('error', () => resolve(null)); req.end();
        });
        if (revision === version) return;
        if (revision !== null) throw new Error('Remote backend smoke test reported a different revision.');
        await delay(100, undefined, { signal });
      }
    };
    await Promise.race([ready(), failed]);
  } catch (error) {
    throw new Error(`The assembled remote backend cannot start. ${error.message}\n${output.trim() || 'No startup output.'}`, { cause: error });
  } finally {
    polling.abort();
    if (child?.pid) {
      const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      kill('SIGTERM');
      let timer;
      try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timer); kill('SIGKILL'); }
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
}
