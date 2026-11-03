import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Data needed by the isolated workbench; no runtime assets enter the checkout. */
export async function stageCodeAssets(root) {
  const destination = join(root, 'apps/desktop/dist/code');
  await mkdir(destination, { recursive: true });
  await copyFile(join(root, 'docs/design-system/project/tokens.css'), join(destination, 'tokens.css'));
  await copyFile(join(root, 'apps/desktop/vendor/vscode/LICENSE.txt'), join(destination, 'LICENSE.txt'));
}
