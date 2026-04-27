const { execSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const outputDir = join(root, 'apps', 'frontend', 'public', 'favicons');
const manifestPath = join(outputDir, 'manifest.webmanifest');
const electronAssetDir = join(root, 'apps', 'electron', 'assets');
const macRuntimeIconPath = join(electronAssetDir, 'macos-runtime-icon.png');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

execSync('npx -y create-favicon 11x.png apps/frontend/public/favicons --overwrite', {
  cwd: root,
  stdio: 'inherit',
});

if (!existsSync(manifestPath)) {
  throw new Error(`Generated manifest not found at ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (Array.isArray(manifest.icons)) {
  manifest.icons = manifest.icons.map((icon) => {
    if (typeof icon?.src !== 'string') {
      return icon;
    }

    return {
      ...icon,
      src: icon.src.replace(/^\//, ''),
    };
  });
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

rmSync(electronAssetDir, { recursive: true, force: true });
mkdirSync(electronAssetDir, { recursive: true });

execSync(
  'npx -y sharp-cli -i 11x.png -o apps/electron/assets resize 384 384 --fit contain --background rgba\\(0,0,0,0\\) -- extend 64 64 64 64 --background rgba\\(0,0,0,0\\) --format png',
  {
    cwd: root,
    stdio: 'inherit',
  },
);

const generatedMacIconPath = join(electronAssetDir, '11x.png');
if (!existsSync(generatedMacIconPath)) {
  throw new Error(`Generated macOS runtime icon not found at ${generatedMacIconPath}`);
}

renameSync(generatedMacIconPath, macRuntimeIconPath);
