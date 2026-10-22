import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { help, parseOptions } from './options.mjs';
import { writeReport } from './report.mjs';
import { CaptureProcesses } from './processes.mjs';
import { compileMain } from './compilation.mjs';
import { prepareRenderer } from './renderer-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = join(root, 'apps/desktop');
const desktopRequire = createRequire(join(desktop, 'package.json'));
const processes = new CaptureProcesses();
let stopReason;
let temporary;

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopReason = `Capture cancelled by ${signal}`;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  void processes.stop();
});

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  if (options.serve) {
    const server = await prepareRenderer(root, options, processes);
    try { await server.done; }
    catch (error) { if (!stopReason) throw error; }
    return;
  }
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
    void processes.stop();
  }, options.timeout * 1000);
  try {
    await compileMain(root, processes);
    const { url } = await prepareRenderer(root, options, processes);
    const config = join(temporary, 'config.json');
    await writeFile(config, JSON.stringify({ ...options, scenario, root, out, temporary, url, startupMs: Math.round(performance.now() - started) }));
    await processes.start(desktopRequire('electron'), [join(desktop, 'test/capture-runner.cjs'), config], root).done;
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
    await processes.stop();
  }
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await processes.stop(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
