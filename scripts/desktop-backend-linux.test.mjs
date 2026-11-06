import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildLinuxDevelopmentRuntime, developmentLinuxArchitecture } from './desktop-backend-linux.mjs';

const version = 'a'.repeat(40);

test('development target flags default Linux to ARM64 and reject ambiguous/unsupported arguments', () => {
  assert.equal(developmentLinuxArchitecture([]), undefined);
  assert.equal(developmentLinuxArchitecture(['--linux']), 'arm64');
  assert.equal(developmentLinuxArchitecture(['--linux', '--arm64']), 'arm64');
  assert.equal(developmentLinuxArchitecture(['--linux', '--x64']), 'x64');
  for (const args of [['--arm64'], ['--linux', '--win'], ['--linux', '--arm64', '--x64'], ['--linux', '--linux']]) {
    assert.throws(() => developmentLinuxArchitecture(args), /desktop:dev/);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ex-linux-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/backend/package.json', 'apps/desktop/package.json',
    'packages/shared/package.json', 'e2e/package.json', 'vscode-filesystem-provider/package.json',
    'vscode-scm-extension/package.json', 'apps/backend/bundle/main.cjs', 'apps/backend/drizzle/migration.sql',
    'apps/backend/bin/helper', 'apps/frontend/proxy.conf.json', 'config/vscode-web-runtime.json',
    'scripts/desktop-backend-runtime.mjs', 'scripts/stage-electron-backend.js',
    'scripts/rebuild-electron-backend-natives.js', 'scripts/archive-electron-backend.js',
    'scripts/prepare-vscode-web-runtime.js', 'scripts/runtime-stage-utils.js', 'scripts/desktop-backend-linux.Dockerfile',
    'vscode-filesystem-provider/dist/extension.js', 'vscode-scm-extension/dist/extension.js',
    // Neither installed dependencies, unrelated sources nor secrets belong in the context.
    'apps/backend/node_modules/native.node', 'apps/desktop/src/unrelated.ts', '.env',
    'apps/backend/node_modules/vscode-web/dist/index.html', 'apps/backend/node_modules/@openai/codex-sdk/dist/index.js',
    'apps/backend/node_modules/@openai/codex-sdk/package.json', 'apps/backend/node_modules/@openai/codex-sdk/LICENSE',
    'apps/backend/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  ];
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), file);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@8.15.4' }));
  await writeFile(join(root, 'apps/backend/package.json'), JSON.stringify({ name: 'elevenex-backend', dependencies: Object.fromEntries(
    ['playwright-core', 'ffmpeg-static', 'better-sqlite3', 'node-pty', '@vscode/ripgrep', 'onnxruntime-node', 'unused-agent-cli'].map(name => [name, '1.0.0']),
  ) }));
  await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '6.0'\nimporters:\n  apps/backend:\n    dependencies:\n${
    ['playwright-core', 'ffmpeg-static', 'better-sqlite3', 'node-pty', '@vscode/ripgrep', 'onnxruntime-node', 'unused-agent-cli'].map(name => `      '${name}':\n        specifier: 1.0.0\n        version: 1.2.3\n`).join('')
  }  apps/other:\n    dependencies: {}\npackages:\n  /unchanged@1.2.3:\n    resolution: {integrity: sha512-original}\n`);
  return root;
}

for (const architecture of ['arm64', 'x64']) {
  test(`Linux ${architecture} build snapshots runtime inputs, exports artifacts and cleans its context`, async t => {
    const root = await fixture(t);
    let context;
    const archiveName = `elevenex-backend-linux-${architecture}.tar.gz`;
    const output = await buildLinuxDevelopmentRuntime(root, version, architecture, async (command, args, cwd) => {
      context = cwd;
      assert.equal(command, 'docker');
      assert.equal(args[args.indexOf('--platform') + 1], `linux/${architecture === 'x64' ? 'amd64' : 'arm64'}`);
      assert.ok(args.includes('PNPM_VERSION=8.15.4'));
      assert.ok(args.includes(`DEVELOPMENT_VERSION=${version}`));
      assert.equal(await readFile(join(cwd, 'runtime/apps/backend/bundle/main.cjs'), 'utf8'), 'apps/backend/bundle/main.cjs');
      const lockfile = await readFile(join(cwd, 'manifests/pnpm-lock.yaml'), 'utf8');
      assert.ok(lockfile.includes("      'better-sqlite3':\n        specifier: 1.0.0\n        version: 1.2.3\n"));
      assert.ok(!lockfile.includes('unused-agent-cli'));
      assert.ok(lockfile.endsWith('  apps/other:\n    dependencies: {}\npackages:\n  /unchanged@1.2.3:\n    resolution: {integrity: sha512-original}\n'));
      const backend = JSON.parse(await readFile(join(cwd, 'manifests/apps/backend/package.json'), 'utf8'));
      assert.equal(backend.dependencies['better-sqlite3'], '1.0.0');
      assert.equal(backend.dependencies['unused-agent-cli'], undefined);
      for (const file of ['runtime/apps/backend/node_modules/native.node', 'runtime/apps/desktop/src', '.env']) {
        await assert.rejects(stat(join(cwd, file)), { code: 'ENOENT' });
      }
      await mkdir(join(cwd, 'output'));
      await writeFile(join(cwd, 'output', archiveName), 'Linux archive');
      await writeFile(join(cwd, 'output', `${archiveName}.sha256`), 'checksum');
    });
    assert.equal(output, join(root, 'dist-runtime', archiveName));
    assert.equal(await readFile(output, 'utf8'), 'Linux archive');
    assert.equal(await readFile(`${output}.sha256`, 'utf8'), 'checksum');
    await assert.rejects(stat(context), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'apps/backend/node_modules/native.node'), 'utf8'), 'apps/backend/node_modules/native.node');
  });
}

test('Docker failure or cancellation removes the build context and never reuses an old archive', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'dist-runtime'));
  const oldArchive = join(root, 'dist-runtime/elevenex-backend-linux-arm64.tar.gz');
  await writeFile(oldArchive, 'old build');
  await assert.rejects(buildLinuxDevelopmentRuntime(root, version, 'arm64', async () => {
    throw new Error('cancelled');
  }), /Docker Desktop or OrbStack/);
  assert.deepEqual(await readdir(join(root, 'apps/desktop/.stage')), []);
  assert.equal(await readFile(oldArchive, 'utf8'), 'old build');
});

test('the shared UI base builds its core runtime without browser dependencies or assets', async t => {
  const root = await fixture(t);
  const manifestPath = join(root, 'apps/backend/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.dependencies['playwright-core'];
  delete manifest.dependencies['ffmpeg-static'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(root, 'config'), { recursive: true });
  await rm(join(root, 'apps/backend/node_modules/vscode-web'), { recursive: true });
  await buildLinuxDevelopmentRuntime(root, version, 'arm64', async (_command, _args, cwd) => {
    const backend = JSON.parse(await readFile(join(cwd, 'manifests/apps/backend/package.json'), 'utf8'));
    assert.deepEqual(Object.keys(backend.dependencies), ['better-sqlite3', 'node-pty', '@vscode/ripgrep', 'onnxruntime-node']);
    assert.equal(await readFile(join(cwd, 'runtime/scripts/runtime-stage-utils.js'), 'utf8'), 'scripts/runtime-stage-utils.js');
    await assert.rejects(stat(join(cwd, 'runtime/vscode-filesystem-provider')), { code: 'ENOENT' });
    await mkdir(join(cwd, 'output'));
    for (const name of ['elevenex-backend-linux-arm64.tar.gz', 'elevenex-backend-linux-arm64.tar.gz.sha256']) {
      await writeFile(join(cwd, 'output', name), 'fixture');
    }
  });
});

test('an unsupported or incomplete source lockfile fails before Docker runs', async t => {
  const root = await fixture(t);
  const original = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  for (const lockfile of [original.replace("'6.0'", "'9.0'"), original.replace("      'better-sqlite3':", "      'other-package':")]) {
    await writeFile(join(root, 'pnpm-lock.yaml'), lockfile);
    await assert.rejects(buildLinuxDevelopmentRuntime(root, version, 'arm64', () => assert.fail('Docker must not run')), /lockfile format|Missing locked runtime dependency/);
    assert.deepEqual(await readdir(join(root, 'apps/desktop/.stage')), []);
  }
});
