/** Prepared replacement metadata and kernel-lock transfer between remote daemons. */
import { fork, type SendHandle } from 'node:child_process';
import type { Socket } from 'node:dgram';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RuntimeReplacement {
  readonly installation: string;
  readonly runtime: string;
  readonly executable: string;
  readonly version: string;
}

export async function publishReplacement(root: string, installation: string, runtime: string, version: string): Promise<void> {
  const temporary = join(root, `.handoff-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ installation: basename(installation), client: basename(dirname(runtime)) }), { mode: 0o600 });
    await rename(temporary, join(root, `handoff-${version}.json`));
  } finally { await rm(temporary, { force: true }); }
}

/** Only an already installed runtime and uploaded shim in this root can run. */
export async function prepareReplacement(root: string, version: string): Promise<RuntimeReplacement> {
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('Invalid replacement revision');
  const path = join(root, `handoff-${version}.json`);
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024) throw new Error('Invalid replacement descriptor');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || !('client' in value) || typeof value.client !== 'string' || !/^[a-f0-9]{64}$/.test(value.client)
    || !('installation' in value) || typeof value.installation !== 'string'
    || !new RegExp(`^runtime-(?:pr-[1-9]\\d*-)?${version}-(?:linux|macos)-(?:arm64|x64)$`).test(value.installation)) throw new Error('Invalid replacement descriptor');
  const installation = join(root, 'runtimes', value.installation);
  const runtime = join(root, 'clients', value.client, 'runtime.js');
  const executable = join(installation, 'backend/node/bin/node');
  for (const path of [runtime, executable, join(installation, 'backend/main.cjs'), join(installation, 'installation.sha256')]) {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error('Incomplete replacement runtime');
  }
  return { installation, runtime, executable, version };
}

/** Attach before any async initialization so an early transferred handle is kept. */
export function inheritOwnership(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error('Handoff requires an IPC parent')); return; }
    const disconnected = () => { cleanup(); reject(new Error('Handoff parent disconnected')); };
    const receive = (message: unknown, handle: SendHandle | undefined) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'ownership' || !handle || !('bind' in handle)) return;
      cleanup(); resolve(handle);
    };
    const cleanup = () => { process.removeListener('message', receive); process.removeListener('disconnect', disconnected); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Handoff ownership timed out')); }, 10000);
    process.on('message', receive); process.once('disconnect', disconnected);
  });
}

/** Keep our reservation until the replacement has adopted it and published health. */
export async function launchReplacement(root: string, replacement: RuntimeReplacement, ownership: Socket): Promise<void> {
  const child = fork(replacement.runtime, ['handoff', root, replacement.installation, replacement.version], {
    execPath: replacement.executable, execArgv: [], cwd: root, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const receive = (message: unknown) => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'adopted') { cleanup(); resolve(); }
      };
      const failed = () => { cleanup(); reject(new Error('Replacement daemon did not adopt ownership')); };
      const cleanup = () => { clearTimeout(timer); child.removeListener('message', receive); child.removeListener('exit', failed); child.removeListener('error', failed); };
      const timer = setTimeout(failed, 10000);
      child.on('message', receive); child.once('exit', failed); child.once('error', failed);
      child.send({ type: 'ownership' }, ownership, { keepOpen: true }, error => { if (error) failed(); });
    });
  } catch (error) {
    // This is our own newly created child, never a PID discovered from disk.
    child.kill('SIGTERM'); throw error;
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}
