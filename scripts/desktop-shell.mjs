import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stageBackendRelease } from './desktop-backend-release.mjs';
import { prepareDevelopmentBackend } from './desktop-backend-development.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, 'apps/desktop');
const renderer = join(root, 'apps/renderer');
const shared = join(root, 'packages/shared');
const desktopRequire = createRequire(join(desktop, 'package.json'));
const rendererRequire = createRequire(join(renderer, 'package.json'));
const tsc = desktopRequire.resolve('typescript/bin/tsc');
const ng = rendererRequire.resolve('@angular/cli/bin/ng.js');
const children = new Set();
let stopping = false;

function launch(entry, args = [], cwd = root, env = {}) {
  if (stopping) throw new Error('Desktop development is stopping');
  const child = spawn(process.execPath, entry ? [entry, ...args] : args, {
    cwd, stdio: 'inherit', env: { ...process.env, ...env },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function completed(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Process exited with ${signal ?? code}`)));
  });
}

function run(entry, args, cwd = root) {
  return completed(launch(entry, args, cwd));
}

async function compileMain() {
  await run(tsc, ['-p', join(shared, 'tsconfig.json')]);
  await run(tsc, ['-p', join(desktop, 'tsconfig.json')]);
  await stageBackendRelease(root);
}

async function syncTokens() {
  const source = join(root, 'docs/design-system/project/tokens.css');
  try {
    await access(source);
  } catch {
    throw new Error('Missing docs/design-system/project/tokens.css. Extract the design-system zip into docs/design-system first.');
  }
  const destination = join(renderer, 'src/design-system');
  await mkdir(destination, { recursive: true });
  await copyFile(source, join(destination, 'tokens.css'));
}

async function build() {
  await compileMain();
  await syncTokens();
  await run(ng, ['build'], renderer);
}

async function stopChildren() {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.allSettled([...children].map((child) => completed(child)));
}

async function dev() {
  await compileMain();
  await syncTokens();
  const backendEnvironment = await prepareDevelopmentBackend(root, run);
  const port = Number(process.env['ELEVENEX_DESKTOP_PORT'] ?? 4300);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ELEVENEX_DESKTOP_PORT');
  const url = `http://127.0.0.1:${port}`;
  const server = launch(ng, ['serve', '--host', '127.0.0.1', '--port', String(port)], renderer);
  let serverStopped = false;
  server.once('exit', () => { serverStopped = true; if (!stopping) void stopChildren(); });
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (serverStopped || stopping) throw new Error('Renderer dev server stopped');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the initial Angular compilation. */ }
    await delay(500);
  }
  if (!ready) throw new Error('Renderer dev server did not become ready');

  const electronPath = desktopRequire('electron');
  let electron;
  let restarting = false;
  let running = false;
  let dirty = false;
  let timer;
  const startElectron = () => {
    const env = { ...process.env, ...backendEnvironment, ELEVENEX_RENDERER_URL: url };
    delete env['ELECTRON_RUN_AS_NODE'];
    electron = spawn(electronPath, [desktop], { cwd: root, stdio: 'inherit', env });
    children.add(electron);
    electron.once('error', (error) => { console.error(error); void stopChildren(); });
    const child = electron;
    child.once('exit', () => {
      children.delete(child);
      if (!restarting && !stopping) void stopChildren();
    });
  };
  const rebuild = async () => {
    if (running || stopping) return;
    running = true;
    dirty = false;
    try {
      // Compile before restarting: a TypeScript error leaves the last good app open.
      await compileMain();
      if (!stopping) {
        restarting = true;
        const exited = completed(electron).catch(() => undefined);
        electron.kill('SIGTERM');
        await exited;
        startElectron();
        restarting = false;
      }
    } catch (error) {
      console.error(error);
    } finally {
      running = false;
      if (dirty && !stopping) void rebuild();
    }
  };
  startElectron();
  const watchers = [join(desktop, 'src'), join(shared, 'src')].map((path) => watch(path, { recursive: true }, () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 150);
  }));
  const tokenWatcher = watch(join(root, 'docs/design-system/project/tokens.css'), () => {
    void syncTokens().catch(console.error);
  });
  try {
    await completed(server);
  } finally {
    clearTimeout(timer);
    for (const watcher of [...watchers, tokenWatcher]) watcher.close();
    await stopChildren();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stopChildren(); });

try {
  const [mode, ...args] = process.argv.slice(2);
  switch (mode) {
    case 'dev': await dev(); break;
    case 'build': await build(); break;
    case 'preview':
      await compileMain();
      await syncTokens();
      await run(ng, ['serve', '--build-target', 'renderer:build:component-preview', '--host', '127.0.0.1', '--port', '4310'], renderer);
      break;
    case 'package':
      await build();
      // Host platform by default; --mac, --win and --linux select explicit targets.
      await run(desktopRequire.resolve('electron-builder/cli.js'), ['--config', 'electron-builder.json', '--publish', 'never', ...args], desktop);
      break;
    case 'test':
      await compileMain();
      await run(null, ['--test', 'test/preload.test.cjs', 'test/security.test.cjs', 'test/machines.test.cjs', 'test/backend-install.test.cjs', 'test/backend-development.test.cjs', 'test/backend-manager.test.cjs', 'test/backend-process.test.cjs', 'test/backend-client.test.cjs', 'test/ipc.test.cjs', 'test/remote.test.cjs', 'test/remote-wire.test.cjs', 'test/remote-audit.test.cjs', 'test/remote-recovery.test.cjs', 'test/ssh-native.test.cjs'], desktop);
      await run(null, ['--test', 'scripts/desktop-capture/test/options.test.mjs', 'scripts/desktop-capture/test/lifecycle.test.mjs']);
      // ng test transpiles TypeScript; tsc also checks the negative IPC type cases.
      await run(tsc, ['-p', join(renderer, 'tsconfig.spec.json'), '--noEmit']);
      await run(ng, ['test', '--watch=false'], renderer);
      break;
    case 'lint':
      await run(join(dirname(desktopRequire.resolve('eslint/package.json')), 'bin/eslint.js'), [
        '--config', 'apps/desktop/eslint.config.mjs', 'apps/desktop/src', 'apps/renderer/src', 'packages/shared/src', '--max-warnings', '0',
        'scripts/desktop-shell.mjs', 'scripts/desktop-backend-development.mjs', 'scripts/desktop-backend-release.mjs', 'scripts/desktop-backend-runtime.mjs', 'scripts/desktop-capture', 'apps/renderer/capture', 'apps/renderer/preview', 'apps/desktop/test', 'apps/desktop/eslint.config.mjs',
      ]);
      break;
    default: throw new Error('Use dev, preview, build, package, test or lint');
  }
} catch (error) {
  console.error(error);
  await stopChildren();
  process.exitCode = 1;
}
