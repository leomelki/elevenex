const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, readdir, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { installFromServer } = require('../dist/remote/server-install');
const { bootstrapScript } = require('../dist/remote/runtime-install');
const { shellQuote } = require('../dist/remote/ssh');
const { backendRelease } = require('../dist/backend/release');
const { downloadBackend } = require('../dist/backend/download');
const { archive, releaseFetch, tar, version } = require('./backend-fixtures.cjs');
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'ex-remote-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('server download retries twice, verifies with the shared validators and cleans staging', async t => {
  const root = await temporary(t); let attempts = 0;
  const bytes = archive(); const remote = releaseFetch(release, bytes);
  await installFromServer(root, release, AbortSignal.timeout(10000), () => {}, async (...args) => {
    if (++attempts < 3) throw new Error('temporary network outage');
    return downloadBackend(...args, remote.request);
  });
  assert.equal(attempts, 3);
  assert.equal(await readFile(join(root, 'backend/main.cjs'), 'utf8'), 'console.log("backend");');
  assert.equal(await readFile(join(root, 'installation.sha256'), 'utf8'), createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual((await readdir(root)).sort(), ['backend', 'installation.sha256']);
});

test('server checksum and unsafe archive failures never publish an installation', async t => {
  for (const unsafe of [false, true]) {
    const root = await temporary(t); let attempts = 0;
    const remote = releaseFetch(release, unsafe ? tar([{ name: 'backend/../escape', body: 'unsafe' }]) : archive(), unsafe ? {} : { checksum: '0'.repeat(64) });
    await assert.rejects(installFromServer(root, release, AbortSignal.timeout(10000), () => {}, async (...args) => {
      attempts++; return downloadBackend(...args, remote.request);
    }), /three attempts/);
    assert.equal(attempts, 3); assert.deepEqual(await readdir(root), []);
  }
});

test('cancellation during server retry backoff cleans up and stops subsequent attempts', async t => {
  const root = await temporary(t); const controller = new AbortController(); let attempts = 0;
  const operation = installFromServer(root, release, controller.signal, () => {}, async () => {
    attempts++; setTimeout(() => controller.abort(), 20); throw new Error('offline');
  });
  await assert.rejects(operation, /abort/i); assert.equal(attempts, 1); assert.deepEqual(await readdir(root), []);
});

for (const fails of [false, true]) test(`native bootstrap ${fails ? 'falls back to SSH transfer after three server failures' : 'downloads on the server without requesting client bytes'}`, async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote bootstrap');
  const home = await temporary(t); const bin = join(home, 'bin'); await mkdir(bin);
  // This preload is confined to the test's node wrapper. Production URLs and
  // every validator remain unchanged; no external service is contacted.
  const bytes = tar([
    { name: 'backend/main.cjs', body: 'fixture' },
    { name: 'backend/node/bin/node', body: '#!/bin/sh\nif [ "$#" -eq 4 ] && [ "$1" = "-e" ]; then mv "$3" "$4"; fi\nexit 0\n', mode: 0o700 },
  ]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const preload = join(home, 'fetch.cjs');
  const calls = join(home, 'calls');
  await writeFile(preload, `globalThis.fetch=async url=>{require('fs').appendFileSync(${JSON.stringify(calls)},'1');if(${fails})throw Error('offline');return String(url).endsWith('.sha256')?new Response('${digest}  ${release.archiveName}'):new Response(Buffer.from('${bytes.toString('base64')}','base64'));};`);
  await writeFile(join(bin, 'node'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(preload)} "$@"\n`, { mode: 0o700 });
  const nonce = randomBytes(16).toString('hex');
  const child = spawn('sh', ['-c', await bootstrapScript(release, nonce)], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(() => child.kill('SIGTERM'));
  let output = ''; let diagnostics = ''; let sent = false;
  child.stderr.on('data', data => { diagnostics += data; });
  child.stdout.on('data', data => {
    output += data;
    if (output.includes(`EX11:${nonce}:cache:no`) && !sent) {
      sent = true; child.stdin.end(Buffer.concat([Buffer.from(`${bytes.length} ${digest}\n`), bytes]));
    }
  });
  assert.equal(await exited, 0, diagnostics); assert.equal(sent, fails);
  assert.equal((await readFile(calls, 'utf8')).length, fails ? 3 : 2);
  const root = join(home, '.elevenex/desktop-remote/runtimes');
  assert.deepEqual(await readdir(root), [`${release.tag}-${release.target}`]);
  assert.equal(await readFile(join(root, `${release.tag}-${release.target}`, 'installation.sha256'), 'utf8'), digest);
  assert.match(output, /installation:start/); assert.match(output, /runtime:start/);
});
