const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const frontendBrowserRoot = path.join(repoRoot, 'apps', 'frontend', 'dist', 'frontend', 'browser');
const backendBundleRoot = path.join(repoRoot, 'apps', 'backend', 'bundle');
const sourceMapsRoot = path.join(repoRoot, 'apps', 'electron', '.stage', 'source-maps');
const sourceMapAssetsRoot = path.join(sourceMapsRoot, 'assets');
const sourceMapManifestPath = path.join(sourceMapsRoot, 'manifest.json');

function getCommitSha() {
  return (process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: repoRoot }).toString()).trim();
}

function walkFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        visit(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  visit(rootDir);
  return files;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function buildReleaseBaseUrl(commitSha) {
  if (process.env.SOURCE_MAP_RELEASE_BASE_URL) {
    return process.env.SOURCE_MAP_RELEASE_BASE_URL.replace(/\/$/, '');
  }

  if (process.env.GITHUB_REPOSITORY) {
    const tag = process.env.SOURCE_MAP_RELEASE_TAG || `runtime-${commitSha}`;
    return `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${tag}`;
  }

  return null;
}

function buildAssetName(commitSha, group, relativeMapPath) {
  const normalizedPath = toPosixPath(relativeMapPath).replace(/[^A-Za-z0-9._-]+/g, '__');
  return `elevenex-source-map-${commitSha}-${group}-${normalizedPath}`;
}

function ensureCleanOutput() {
  rmSync(sourceMapsRoot, { recursive: true, force: true });
  mkdirSync(sourceMapAssetsRoot, { recursive: true });
}

function collectMaps(rootDir, group, commitSha, releaseBaseUrl) {
  const entries = [];
  for (const mapPath of walkFiles(rootDir).filter((file) => file.endsWith('.map'))) {
    const relativeMapPath = path.relative(rootDir, mapPath);
    const assetName = buildAssetName(commitSha, group, relativeMapPath);
    copyFileSync(mapPath, path.join(sourceMapAssetsRoot, assetName));

    entries.push({
      group,
      path: toPosixPath(relativeMapPath),
      asset: assetName,
      url: releaseBaseUrl ? `${releaseBaseUrl}/${assetName}` : null,
    });
  }

  return entries;
}

function rewriteFrontendSourceMappingUrls(frontendMaps) {
  const mapByRelativePath = new Map(frontendMaps.map((entry) => [entry.path, entry]));
  for (const mapEntry of frontendMaps) {
    if (!mapEntry.url) {
      continue;
    }

    const compiledRelativePath = mapEntry.path.replace(/\.map$/, '');
    const compiledPath = path.join(frontendBrowserRoot, compiledRelativePath);
    if (!existsSync(compiledPath)) {
      continue;
    }

    const source = readFileSync(compiledPath, 'utf8');
    const replacement = mapEntry.url;
    const rewritten = source
      .replace(/\/\/# sourceMappingURL=[^\r\n]+/g, `//# sourceMappingURL=${replacement}`)
      .replace(/\/\*# sourceMappingURL=[^*]+\*\//g, `/*# sourceMappingURL=${replacement} */`);

    if (rewritten !== source) {
      writeFileSync(compiledPath, rewritten, 'utf8');
    } else if (mapByRelativePath.has(mapEntry.path)) {
      const suffix = compiledPath.endsWith('.css')
        ? `\n/*# sourceMappingURL=${replacement} */\n`
        : `\n//# sourceMappingURL=${replacement}\n`;
      writeFileSync(compiledPath, `${source.replace(/\s*$/, '')}${suffix}`, 'utf8');
    }
  }
}

function writeManifest(commitSha, releaseBaseUrl, maps) {
  const manifest = {
    version: commitSha,
    releaseTag: process.env.SOURCE_MAP_RELEASE_TAG || `runtime-${commitSha}`,
    releaseBaseUrl,
    maps,
  };
  writeFileSync(sourceMapManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function main() {
  const commitSha = getCommitSha();
  const releaseBaseUrl = buildReleaseBaseUrl(commitSha);

  ensureCleanOutput();
  const frontendMaps = collectMaps(frontendBrowserRoot, 'frontend', commitSha, releaseBaseUrl);
  const backendMaps = collectMaps(backendBundleRoot, 'backend', commitSha, releaseBaseUrl);
  rewriteFrontendSourceMappingUrls(frontendMaps);
  writeManifest(commitSha, releaseBaseUrl, [...frontendMaps, ...backendMaps]);

  console.log(`Collected ${frontendMaps.length} frontend source maps and ${backendMaps.length} backend source maps.`);
  console.log(`Source map manifest written to ${path.relative(repoRoot, sourceMapManifestPath)}`);
}

main();
