const { execFileSync, execSync } = require('child_process');
const { lstatSync, readlinkSync, rmSync } = require('fs');
const { createRequire } = require('module');
const { join } = require('path');

const root = join(__dirname, '..');
const extensionDirs = ['vscode-filesystem-provider', 'vscode-scm-extension'];

// Older revisions of this script hand-built `node_modules/.bin` entries for the
// extensions as symlinks into pnpm's virtual store. Anything that later wrote a
// real shim over such an entry followed the symlink and truncated the actual
// `webpack-cli/bin/cli.js` inside `node_modules/.pnpm`, which also corrupts the
// hardlinked global store. Drop the leftovers so they cannot do that again;
// pnpm recreates proper shims whenever it links bins.
function removeStaleBinSymlinks(packageDir) {
  const binDir = join(packageDir, 'node_modules', '.bin');

  for (const binName of ['webpack', 'webpack-cli']) {
    const binPath = join(binDir, binName);

    try {
      if (!lstatSync(binPath).isSymbolicLink()) continue;
      if (!readlinkSync(binPath).includes('webpack-cli')) continue;
    } catch {
      continue;
    }

    rmSync(binPath, { force: true });
  }
}

// pnpm links every workspace package's dependencies before it runs the root
// lifecycle scripts, so plain Node resolution from the extension finds the
// toolchain. Never scan `node_modules/.pnpm` by hand: its directory names are
// resolution-dependent and change whenever the lockfile does.
function buildExtension(packageDir) {
  removeStaleBinSymlinks(packageDir);

  const requireFromExtension = createRequire(join(packageDir, 'package.json'));
  const webpackCliEntry = requireFromExtension.resolve('webpack-cli/bin/cli.js');

  execFileSync(process.execPath, [webpackCliEntry, '--mode', 'production'], {
    cwd: packageDir,
    stdio: 'inherit',
  });
}

// 1. Build custom VS Code extensions
console.log('Building VS Code extensions...');
try {
  for (const extensionDir of extensionDirs) {
    buildExtension(join(root, extensionDir));
  }
} catch (e) {
  console.error('Failed to build VS Code extensions:', e.message);
  process.exit(1);
}

// 2. Generate favicon assets from the canonical logo source
console.log('Generating Elevenex favicon assets...');
try {
  execSync('pnpm assets:icons', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('Failed to generate favicon assets:', e.message);
  process.exit(1);
}

console.log('Done.');
