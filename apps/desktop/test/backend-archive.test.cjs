const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { cp, mkdtemp, mkdir, rm, stat } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { promisify } = require('node:util');
const { pruneStagedNodeModules } = require('../../../scripts/archive-electron-backend');

const run = promisify(execFile);
const backendRequire = createRequire(require.resolve('../../backend/package.json'));

test('browser runtime packages remain usable after final pruning and archive extraction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-backend-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, 'stage/backend/node_modules');
  await mkdir(modules, { recursive: true });
  for (const name of ['playwright-core', 'ffmpeg-static']) {
    await cp(dirname(backendRequire.resolve(`${name}/package.json`)), join(modules, name), { recursive: true, dereference: true });
  }
  // Installation-only dependencies must still be removed from the runtime.
  await mkdir(join(modules, 'https-proxy-agent'));
  pruneStagedNodeModules(modules);
  await assert.rejects(stat(join(modules, 'https-proxy-agent')), { code: 'ENOENT' });
  await assert.rejects(stat(join(modules, 'ffmpeg-static/install.js')), { code: 'ENOENT' });

  const archive = join(root, 'backend.tar.gz');
  await run('tar', ['-czf', archive, '-C', join(root, 'stage'), 'backend']);
  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  await run('tar', ['-xzf', archive, '-C', extracted]);
  // Remove the source tree so resolution cannot accidentally use staged files.
  await rm(join(root, 'stage'), { recursive: true });
  const extractedModules = join(extracted, 'backend/node_modules');
  const playwrightRoot = join(extractedModules, 'playwright-core');
  const { stdout } = await run(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { chromium } = require(process.argv[1]);
    assert.equal(typeof chromium.launch, 'function');
    assert.equal(typeof chromium.executablePath(), 'string');
  `, playwrightRoot], { timeout: 10000 });
  assert.equal(stdout, '');
  const cli = await run(process.execPath, [join(playwrightRoot, 'cli.js'), 'install', '--dry-run', 'chromium', '--no-shell'], { timeout: 10000 });
  assert.match(cli.stdout, /chromium/i);
  for (const name of ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt', 'browsers.json']) {
    assert.ok((await stat(join(playwrightRoot, name))).isFile());
  }
  assert.ok((await stat(join(playwrightRoot, 'bin'))).isDirectory());
  const ffmpegRoot = join(extractedModules, 'ffmpeg-static');
  const ffmpeg = join(ffmpegRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const env = { ...process.env };
  delete env.FFREPORT;
  const video = await run(ffmpeg, ['-version'], { timeout: 10000, env });
  assert.match(video.stdout, /ffmpeg version/);
  assert.ok((await stat(join(ffmpegRoot, 'LICENSE'))).isFile());
});
