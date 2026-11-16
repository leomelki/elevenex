import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyLinuxCompatibility } from './desktop-backend-compatibility.mjs';

const requirements = names => `Version needs section '.gnu.version_r' contains entries:\n${names.map(name => `  Name: ${name} Flags: none`).join('\n')}`;
async function fixture(t) {
  const root = await mkdtemp('/tmp/ex-elf-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules/node-pty/build/Release'), { recursive: true });
  await writeFile(join(root, 'node_modules/node-pty/build/Release/pty.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await writeFile(join(root, 'main.cjs'), 'JavaScript does not need readelf');
  return root;
}

test('portable runtime accepts Node 24 system-library baseline and ignores version definitions', async t => {
  const root = await fixture(t); const inspected = [];
  await verifyLinuxCompatibility(root, undefined, async path => {
    inspected.push(path);
    return `Version definition section:\nName: GLIBC_2.99\n${requirements(['GLIBC_2.28', 'GLIBCXX_3.4.25', 'CXXABI_1.3.11'])}`;
  });
  assert.deepEqual(inspected, [join(root, 'node_modules/node-pty/build/Release/pty.node')]);
});

for (const version of ['GLIBC_2.34', 'GLIBC_2.32', 'GLIBCXX_3.4.29', 'CXXABI_1.3.13', 'GLIBC_ABI_DT_RELR']) {
  test(`portable runtime rejects ${version} before publishing an archive`, async t => {
    const root = await fixture(t);
    await assert.rejects(verifyLinuxCompatibility(root, undefined, async () => requirements([version])), error => {
      assert.match(error.message, /node-pty.*pty.node/);
      assert.ok(error.message.includes(version));
      return true;
    });
  });
}

test('failed ELF inspection and cancellation cannot silently pass validation', async t => {
  const root = await fixture(t);
  await assert.rejects(verifyLinuxCompatibility(root, undefined, async () => { throw new Error('readelf failed'); }), /readelf failed/);
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(verifyLinuxCompatibility(root, cancellation.signal), /abort/i);
});
