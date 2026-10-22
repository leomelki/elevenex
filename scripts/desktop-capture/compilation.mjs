import { createRequire } from 'node:module';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function latest(paths) {
  const times = await Promise.all(paths.map(async path => {
    const info = await stat(path);
    if (!info.isDirectory()) return info.mtimeMs;
    return Math.max(info.mtimeMs, await latest((await readdir(path)).map(name => join(path, name))));
  }));
  return Math.max(0, ...times);
}

export async function compileMain(root, processes) {
  const desktop = join(root, 'apps/desktop');
  const desktopRequire = createRequire(join(desktop, 'package.json'));
  const stamp = join(desktop, 'dist/.capture-compiled');
  const inputs = ['apps/desktop/src', 'packages/shared/src', 'apps/desktop/tsconfig.json', 'packages/shared/tsconfig.json', 'apps/desktop/package.json', 'packages/shared/package.json', 'tsconfig.desktop.json', 'pnpm-lock.yaml'];
  const changed = await latest(inputs.map(path => join(root, path)));
  const previous = await stat(stamp).catch(() => undefined);
  const outputs = ['main.js', 'preload.js', 'ipc.js', 'security.js', 'window-state.js'];
  const complete = (await Promise.all(outputs.map(file => stat(join(desktop, 'dist', file)).catch(() => undefined)))).every(Boolean);
  if (previous && previous.mtimeMs >= changed && complete) return;
  const tsc = desktopRequire.resolve('typescript/bin/tsc');
  for (const project of ['packages/shared', 'apps/desktop']) await processes.start(process.execPath, [tsc, '-p', join(root, project, 'tsconfig.json')], root).done;
  await writeFile(stamp, 'Only source/config/lockfile changes require recompilation.\n');
}
