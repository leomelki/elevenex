import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { help, parseOptions } from './options.mjs';
import { writeReport } from './report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = join(root, 'apps/desktop');
const renderer = join(root, 'apps/renderer');
const desktopRequire = createRequire(join(desktop, 'package.json'));
const rendererRequire = createRequire(join(renderer, 'package.json'));
const children = new Set();
let stopped = false;
let stopReason;
let temporary;

function start(executable, args, cwd = root, extraEnv = {}) {
  if (stopped) throw new Error('Capture stopped');
  const env = { ...process.env, ...extraEnv };
  delete env['ELECTRON_RUN_AS_NODE'];
  const child = spawn(executable, args, { cwd, env, stdio: 'inherit' });
  const done = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`Capture process exited with ${signal ?? code}`)));
  });
  // Attach rejection handling immediately, including long-lived Angular processes.
  void done.catch(() => undefined);
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', () => children.delete(child));
  return { child, done };
}

async function stop() {
  stopped = true;
  const pending = [...children].map(child => new Promise(resolveExit => {
    child.once('exit', resolveExit);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }));
  await Promise.all(pending);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopReason = `Capture cancelled by ${signal}`;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  void stop();
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function latest(paths) {
  const times = await Promise.all(paths.map(async path => {
    const info = await stat(path);
    if (!info.isDirectory()) return info.mtimeMs;
    return Math.max(info.mtimeMs, await latest((await readdir(path)).map(name => join(path, name))));
  }));
  return Math.max(0, ...times);
}

async function compileMain() {
  const stamp = join(desktop, 'dist/.capture-compiled');
  const inputs = ['apps/desktop/src', 'packages/shared/src', 'apps/desktop/tsconfig.json', 'packages/shared/tsconfig.json', 'apps/desktop/package.json', 'packages/shared/package.json', 'tsconfig.desktop.json', 'pnpm-lock.yaml'];
  const changed = await latest(inputs.map(path => join(root, path)));
  const previous = await stat(stamp).catch(() => undefined);
  const outputs = ['main.js', 'preload.js', 'ipc.js', 'security.js', 'window-state.js'];
  const complete = (await Promise.all(outputs.map(file => stat(join(desktop, 'dist', file)).catch(() => undefined)))).every(Boolean);
  if (previous && previous.mtimeMs >= changed && complete) return;
  const tsc = desktopRequire.resolve('typescript/bin/tsc');
  for (const project of ['packages/shared', 'apps/desktop']) await start(process.execPath, [tsc, '-p', join(root, project, 'tsconfig.json')]).done;
  await writeFile(stamp, 'Only source/config/lockfile changes require recompilation.\n');
}

async function angular(options) {
  if (options.built) return undefined;
  if (options.url) {
    const response = await fetch(options.url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Renderer returned HTTP ${response.status}`);
    return options.url;
  }
  if (!options.fixture) {
    await access(join(renderer, 'src/main.ts')).catch(() => { throw new Error('The product renderer has no src/main.ts yet. Use --fixture to verify the capture tool, or supply --url when the shell is available.'); });
    // Match desktop:dev: use only the authoritative source, never invent tokens.
    const tokens = await readFile(join(root, 'docs/design-system/project/tokens.css'));
    await mkdir(join(renderer, 'src/design-system'), { recursive: true });
    await writeFile(join(renderer, 'src/design-system/tokens.css'), tokens);
  }
  const port = options.port ?? await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const target = options.fixture ? 'renderer:build:capture-fixture' : 'renderer:build:development';
  const server = start(process.execPath, [rendererRequire.resolve('@angular/cli/bin/ng.js'), 'serve', '--build-target', target, '--host', '127.0.0.1', '--port', String(port)], renderer);
  for (let attempt = 0; attempt < 300; attempt++) {
    if (stopped || server.child.exitCode !== null || server.child.signalCode !== null) throw new Error('Angular stopped before becoming ready');
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch { /* Initial Angular compilation. */ }
    if (response?.ok) {
      console.log(`CAPTURE_RENDERER_URL=${url}`);
      if (options.serve) {
        try { await server.done; }
        catch (error) { if (!stopReason) throw error; }
      }
      return url;
    }
    await delay(100);
  }
  throw new Error('Angular did not become ready; inspect the build diagnostics above');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  if (options.serve) { await angular(options); return; }
  let scenario;
  if (!options.scenario || options.scenario === '-') {
    if (process.stdin.isTTY) throw new Error('Pipe a scenario module into stdin, or provide its path. See --help.');
    let source = '';
    for await (const chunk of process.stdin) {
      source += chunk;
      if (source.length > 1024 * 1024) throw new Error('Scenario exceeds 1 MiB');
    }
    if (!source.trim()) throw new Error('Scenario stdin is empty');
    scenario = { source, label: 'stdin' };
  } else {
    const path = resolve(root, options.scenario);
    if (!/\.m?js$/.test(path)) throw new Error('Scenario must be a .mjs or .js module');
    await access(path);
    scenario = { url: pathToFileURL(path).href, label: path };
  }
  const base = join(root, 'artifacts/desktop-capture');
  await mkdir(base, { recursive: true });
  const out = options.out ? resolve(root, options.out) : await mkdtemp(join(base, 'run-'));
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error(`Output directory must be empty: ${out}`);
  temporary = await mkdtemp(join(tmpdir(), 'elevenex-capture-'));
  const started = performance.now();
  const deadline = setTimeout(() => {
    stopReason = 'Capture deadline exceeded';
    console.error(stopReason);
    process.exitCode = 1;
    void stop();
  }, options.timeout * 1000);
  try {
    await compileMain();
    const url = await angular(options);
    const config = join(temporary, 'config.json');
    await writeFile(config, JSON.stringify({ ...options, scenario, root, out, temporary, url, startupMs: Math.round(performance.now() - started) }));
    await start(desktopRequire('electron'), [join(desktop, 'test/capture-runner.cjs'), config]).done;
    // Electron can quit with code zero before a scenario completes (for example
    // when its window closes). Only a verified native report establishes success.
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    if (stopReason || !report.verified) throw new Error(stopReason ?? report.failure ?? 'Electron exited before verification');
    console.log(`CAPTURE_REPORT=${join(out, 'report.json')}\nCAPTURE_GALLERY=${join(out, 'index.html')}`);
  } catch (error) {
    // Preserve native-runner reports. Startup/build failures need diagnostics too.
    if (stopReason && await stat(join(out, 'report.json')).catch(() => undefined)) {
      const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
      await writeReport(out, { ...report, verified: false, cancelled: true, failure: `${stopReason}\n${report.failure ?? ''}` });
    } else if (!(await stat(join(out, 'report.json')).catch(() => undefined))) {
      await writeReport(out, { scenario: scenario.label, fixture: !!options.fixture, verified: false,
        captures: [], errors: [error.message], warnings: [], failure: error.stack,
        startupMs: Math.round(performance.now() - started), totalMs: 0 });
    }
    console.error(`CAPTURE_REPORT=${join(out, 'report.json')}`);
    throw error;
  } finally {
    clearTimeout(deadline);
    await stop();
  }
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await stop(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
