import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { verifyRemoteBackend } from './desktop-backend-smoke.mjs';
import { verifyLinuxCompatibility } from './desktop-backend-compatibility.mjs';
import { buildLinuxDevelopmentRuntime } from './desktop-backend-linux.mjs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stagingRoot = join(root, 'apps/desktop/.stage');
const targets = { darwin: 'macos', win32: 'windows', linux: 'linux' };
const target = targets[process.platform];
if (!target || !['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported backend build target');
const developmentVersion = process.argv[2];
if (developmentVersion !== undefined && !/^[a-f0-9]{40}$/.test(developmentVersion)) throw new Error('Invalid development runtime revision');
await mkdir(stagingRoot, { recursive: true });
const stage = await mkdtemp(join(stagingRoot, 'backend-'));
const lifetime = new AbortController();
let active;
let interrupted = false;

function stop() {
  interrupted = true;
  lifetime.abort();
  if (!active?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(active.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', error => console.error('Could not stop backend build:', error));
  } else {
    try { process.kill(-active.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') console.error('Could not stop backend build:', error); }
  }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function runCommand(command, args, cwd = root, environment = {}) {
  if (interrupted) throw new Error('Backend build was cancelled');
  await new Promise((resolve, reject) => {
    active = spawn(command, args, {
      cwd, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, ...environment },
    });
    active.once('error', reject);
    active.once('exit', (code, signal) => {
      active = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}
const run = script => runCommand(process.execPath, [join(root, 'scripts', script)], root, {
  ELEVENEX_EMBED_LOCAL_NODE: '1', ELEVENEX_BACKEND_STAGE_ROOT: stage,
  ...(developmentVersion ? { ELEVENEX_BACKEND_STAGE_VERSION: developmentVersion } : {}),
});

try {
  if (process.platform === 'linux' && process.env.ELEVENEX_LINUX_RUNTIME_BUILDER !== '1') {
    const version = developmentVersion || process.env.ELEVENEX_BACKEND_STAGE_VERSION || process.env.GIT_SHA
      || (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
    await buildLinuxDevelopmentRuntime(root, version, process.arch, runCommand);
  } else {
    // Reuse the curated dependency/assets assembly. Bundled Node selects Node ABI
    // validation instead of rebuilding for the legacy Electron ABI. Stage roots
    // and asset names are separate, so existing app releases keep their behavior.
    await run('stage-electron-backend.js');
    await run('rebuild-electron-backend-natives.js');
    await run('archive-electron-backend.js');
    if (process.platform === 'linux') await verifyLinuxCompatibility(join(stage, 'backend'), lifetime.signal);
    if (process.platform !== 'win32') {
      // Native require checks alone miss bundled JS, migration and startup bugs.
      // Validate the final pruned runtime before publishing a transferable archive.
      const version = (await readFile(join(stage, 'backend/version'), 'utf8')).trim();
      await verifyRemoteBackend(join(stage, 'backend'), join(stage, 'backend/node/bin/node'), version, AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]));
    }
    const output = join(root, 'dist-runtime');
    await mkdir(output, { recursive: true });
    const archiveName = `elevenex-backend-${target}-${process.arch}.tar.gz`;
    const destination = join(output, archiveName);
    await copyFile(join(stage, 'backend.tar.gz'), destination);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(destination)) hash.update(bytes);
    await writeFile(`${destination}.sha256`, `${hash.digest('hex')}  ${archiveName}\n`);
    console.log(`Backend runtime and checksum written to ${destination}`);
  }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await rm(stage, { recursive: true, force: true, maxRetries: 3 });
}
