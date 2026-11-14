// Run after pnpm backend:bundle. This deliberately tests the shipped single-file
// entry with only its declared external dependency, outside a source checkout.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const backendRequire = createRequire(require.resolve('../apps/backend/package.json'));

test('archived browser setup works without checkout, pnpm, native addons or backend listeners', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-setup-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  await mkdir(join(stage, 'backend/node_modules'), { recursive: true });
  await cp(new URL('../apps/backend/bundle/browser-setup.cjs', import.meta.url), join(stage, 'backend/browser-setup.cjs'));
  await cp(dirname(backendRequire.resolve('playwright-core/package.json')), join(stage, 'backend/node_modules/playwright-core'), { recursive: true, dereference: true });
  await run('tar', ['-czf', join(root, 'backend.tar.gz'), '-C', stage, 'backend']);
  await run('tar', ['-xzf', join(root, 'backend.tar.gz'), '-C', root]);
  await rm(stage, { recursive: true });
  const entry = join(root, 'backend/browser-setup.cjs');
  const data = join(root, "data with ' and spaces");
  const options = { timeout: 10000, cwd: root, env: { ...process.env, NODE_PATH: '', ELEVENEX_DATA_ROOT: data } };
  const help = await run(process.execPath, [entry, '--help'], options);
  assert.match(help.stdout, /--system/);
  assert.match(help.stdout, /--check/);
  assert.equal(help.stderr, '');
  await assert.rejects(run(process.execPath, [entry, '--check', '--data-root', data], options), error => {
    assert.equal(error.code, 1);
    // CI running as root is rejected explicitly, never reported as ready.
    assert.match(error.stderr, /not installed|non-root/);
    return true;
  });
  await assert.rejects(run(process.execPath, [entry, '--system'], options), error => {
    assert.match(error.stderr, /explicit --data-root/);
    return true;
  });
  await assert.rejects(run(process.execPath, [entry, '--system', '--check', '--data-root', data], options), error => {
    assert.match(error.stderr, /cannot be combined/);
    return true;
  });
  assert.ok(!(await readdir(root)).some(name => name.startsWith('data')));
});
