import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
/** Data needed by the isolated workbench; no runtime assets enter the checkout. */
export async function stageCodeAssets(root) {
  const destination = join(root, 'apps/desktop/dist/code');
  await mkdir(destination, { recursive: true });
  await copyFile(join(root, 'docs/design-system/project/tokens.css'), join(destination, 'tokens.css'));
  await copyFile(join(root, 'apps/desktop/vendor/vscode/LICENSE.txt'), join(destination, 'LICENSE.txt'));
  // A browser extension host supplies only `vscode` to CommonJS require. Bundle
  // our modules with the esbuild already owned by the Angular build toolchain.
  const rendererRequire = createRequire(join(root, 'apps/renderer/package.json'));
  const buildRequire = createRequire(rendererRequire.resolve('@angular/build/package.json'));
  const { build } = buildRequire('esbuild');
  await build({ entryPoints: [join(root, 'apps/desktop/src/code/web/extension.ts')], outfile: join(destination, 'web/extension.js'), bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['vscode'] });
}
