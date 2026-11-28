import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyRemoteBackend } from './desktop-backend-smoke.mjs';

const version = 'a'.repeat(40);
async function fixture(t, source) {
  const root = await mkdtemp('/tmp/ex-smoke-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'main.cjs'), source);
  return root;
}

test('remote smoke uses isolated data and HOME, verifies the revision and cleans the process tree', async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote runtime');
  const root = await fixture(t, `
    const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),{spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(path.join(__dirname,'state.json'),JSON.stringify({pid:process.pid,worker:worker.pid,home:process.env.HOME,data:process.env.ELEVENEX_DATA_ROOT,mode:process.env.ELEVENEX_BACKEND_MODE}));
    http.createServer((req,res)=>res.end(JSON.stringify({backendSha:${JSON.stringify(version)}}))).listen(process.env.ELEVENEX_DESKTOP_SOCKET);
  `);
  await verifyRemoteBackend(root, process.execPath, version);
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(state.mode, 'remote');
  assert.equal(state.data, join(state.home, 'data'));
  await assert.rejects(readFile(join(state.home, 'data/elevenex.db')), { code: 'ENOENT' });
  for (const pid of [state.pid, state.worker]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('remote smoke rejects early module failure with bounded diagnostics', async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote runtime');
  const root = await fixture(t, `process.stderr.write('x'.repeat(20000)+'\\nfixture loader failure\\n');process.exitCode=9;`);
  const started = Date.now();
  await assert.rejects(verifyRemoteBackend(root, process.execPath, version), error => {
    assert.match(error.message, /fixture loader failure/);
    assert.ok(error.message.length < 17000);
    return true;
  });
  assert.ok(Date.now() - started < 5000);
});

test('remote smoke rejects revision mismatches and cancels a backend that never listens', async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote runtime');
  const root = await fixture(t, `require('http').createServer((req,res)=>res.end(JSON.stringify({backendSha:'b'.repeat(40)}))).listen(process.env.ELEVENEX_DESKTOP_SOCKET);`);
  await assert.rejects(verifyRemoteBackend(root, process.execPath, version), /different revision/);
  await writeFile(join(root, 'main.cjs'), 'setInterval(()=>{},1000);');
  await assert.rejects(verifyRemoteBackend(root, process.execPath, version, AbortSignal.timeout(200)), /abort/i);
});
