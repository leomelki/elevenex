import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Stamp the exact compatible backend into the app, never resolve "latest" at runtime. */
export async function stageBackendRelease(root) {
  const desktop = join(root, 'apps/desktop');
  const require = createRequire(join(desktop, 'package.json'));
  const { backendRelease } = require('./dist/backend/release.js');
  const version = process.env['ELEVENEX_BACKEND_VERSION']
    ?? (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
  const tag = process.env['ELEVENEX_RELEASE_TAG'] ?? `runtime-${version}`;
  backendRelease({ version, tag }, process.platform, process.arch);
  await writeFile(join(desktop, 'dist/backend-release.json'), `${JSON.stringify({ version, tag })}\n`);
}
