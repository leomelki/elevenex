import { stageCodeAssets } from '../desktop-code-assets.mjs';
import { createRequire } from 'node:module';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateDesktopIcons } from '../desktop-icons.mjs';

async function latest(paths) {
  const times = await Promise.all(paths.map(async path => {
    const info = await stat(path);
    if (!info.isDirectory()) return info.mtimeMs;
    return Math.max(info.mtimeMs, await latest((await readdir(path)).map(name => join(path, name))));
  }));
  return Math.max(0, ...times);
}

export async function compileMain(root, processes) {
  await generateDesktopIcons(root);
  const desktop = join(root, 'apps/desktop');
  const desktopRequire = createRequire(join(desktop, 'package.json'));
  const stamp = join(desktop, 'dist/.capture-compiled');
  const inputs = ['packages/browser-inspection/src', 'packages/browser-inspection/tsconfig.json', 'packages/browser-inspection/package.json', 'packages/browser-network/src', 'packages/browser-network/tsconfig.json', 'packages/browser-network/package.json', 'apps/desktop/src', 'packages/shared/src', 'apps/desktop/tsconfig.json', 'packages/shared/tsconfig.json', 'apps/desktop/package.json', 'packages/shared/package.json', 'tsconfig.desktop.json', 'pnpm-lock.yaml'];
  const changed = await latest(inputs.map(path => join(root, path)));
  const previous = await stat(stamp).catch(() => undefined);
  const outputs = ['main.js', 'preload.js', 'ipc.js', 'security.js', 'window-state.js'];
  const complete = (await Promise.all(outputs.map(file => stat(join(desktop, 'dist', file)).catch(() => undefined)))).every(Boolean);
  if (previous && previous.mtimeMs >= changed && complete) return;
  const tsc = desktopRequire.resolve('typescript/bin/tsc');
  for (const project of ['packages/browser-network', 'packages/shared', 'packages/browser-inspection', 'apps/desktop']) await processes.start(process.execPath, [tsc, '-p', join(root, project, 'tsconfig.json')], root).done;
  await stageCodeAssets(root);
  await writeFile(stamp, 'Only source/config/lockfile changes require recompilation.\n');
}
