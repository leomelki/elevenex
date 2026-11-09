import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: [
    fileURLToPath(new URL('src/playwright-worker.ts', import.meta.url)),
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['playwright-core', '@playwright/test'],
  write: false,
  legalComments: 'none',
});
// eval workers do not inherit module resolution from the importing package.
// Resolve only the two external packages in the parent, without copying env or
// command-line hooks, and keep Node's own resolution for their dependencies.
const source = `(function(require){${result.outputFiles[0].text}\n})(function(id){const modules=require('node:worker_threads').workerData.modules;return require(Object.hasOwn(modules,id)?modules[id]:id);});`;
await writeFile(
  new URL('dist/playwright-worker-source.js', import.meta.url),
  `exports.PLAYWRIGHT_WORKER_SOURCE=${JSON.stringify(source)};\n`,
);
