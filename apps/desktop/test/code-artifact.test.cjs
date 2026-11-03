const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CodeArtifact } = require('../dist/code/artifact');

test('failed verified installs leave no published runtime, share startup, and permit explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-artifact-'));
  const originalFetch = globalThis.fetch;
  const artifact = new CodeArtifact(root);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new globalThis.Response('untrusted archive bytes'); };
  try {
    const first = artifact.prepare(), second = artifact.prepare();
    assert.equal(first, second, 'Concurrent mounts downloaded independently');
    await assert.rejects(first, /integrity verification/);
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(artifact.prepare(), /integrity verification/);
    assert.equal(requests, 2);
    assert.deepEqual(await readdir(root), []);
  } finally { globalThis.fetch = originalFetch; await artifact.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('disposing a runtime owner aborts an in-flight download and removes staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-artifact-cancel-'));
  const originalFetch = globalThis.fetch, artifact = new CodeArtifact(root);
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, options) => { started(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); };
  try {
    const installation = artifact.prepare();
    const rejected = assert.rejects(installation);
    await downloading; await artifact.dispose(); await rejected;
    assert.deepEqual(await readdir(root), []);
  } finally { globalThis.fetch = originalFetch; await artifact.dispose(); await rm(root, { recursive: true, force: true }); }
});
