import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';

function resolveVSCodeStaticPathForRoot(root: string): string | null {
  const candidates = new Set<string>([
    join(root, 'vscode-web-dist'),
    join(root, 'apps', 'backend', 'node_modules', 'vscode-web', 'dist'),
  ]);

  const packageAnchors = [
    join(root, 'package.json'),
    join(root, 'apps', 'backend', 'package.json'),
  ];

  for (const packageAnchor of packageAnchors) {
    if (!existsSync(packageAnchor)) {
      continue;
    }

    try {
      const scopedRequire = createRequire(packageAnchor);
      const vscodeWebPackageJson = scopedRequire.resolve('vscode-web/package.json');
      candidates.add(join(dirname(vscodeWebPackageJson), 'dist'));
    } catch {
      // Ignore missing package resolution for this anchor and continue searching.
    }
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'))) {
      return candidate;
    }
  }

  return null;
}

function getExplicitRuntimeRoot(): string | null {
  const explicitRoot = process.env.ELEVENEX_BACKEND_RUNTIME_ROOT?.trim();
  return explicitRoot ? resolve(explicitRoot) : null;
}

function resolveBackendRootCandidates(): string[] {
  return [
    process.cwd(),
    join(process.cwd(), 'apps', 'backend'),
    join(process.cwd(), '..', '..'),
    join(process.cwd(), '..'),
    resolve(__dirname, '..', '..'),
    resolve(__dirname, '..'),
    resolve(__dirname, '..', '..', '..', '..'),
  ];
}

function resolveAssetsRootCandidates(): string[] {
  return [
    process.cwd(),
    join(process.cwd(), '..', '..'),
    resolve(__dirname, '..', '..', '..', '..'),
  ];
}

export function getBackendRuntimeRoot(): string {
  const explicitRoot = getExplicitRuntimeRoot();
  if (explicitRoot) {
    return explicitRoot;
  }

  for (const candidate of resolveBackendRootCandidates()) {
    if (
      existsSync(join(candidate, 'proxy.conf.json'))
      || existsSync(join(candidate, 'apps', 'frontend', 'proxy.conf.json'))
    ) {
      return candidate;
    }
  }

  for (const candidate of resolveBackendRootCandidates()) {
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  return process.cwd();
}

export function getBackendAssetsRoot(): string {
  const explicitRoot = getExplicitRuntimeRoot();
  if (explicitRoot) {
    return explicitRoot;
  }

  for (const candidate of resolveAssetsRootCandidates()) {
    if (resolveVSCodeStaticPathForRoot(candidate)) {
      return candidate;
    }
  }

  return resolve(__dirname, '..', '..', '..', '..');
}

export function getBackendVSCodeStaticPath(): string {
  const explicitRoot = getExplicitRuntimeRoot();
  if (explicitRoot) {
    return resolveVSCodeStaticPathForRoot(explicitRoot) ?? join(explicitRoot, 'vscode-web-dist');
  }

  for (const candidate of resolveAssetsRootCandidates()) {
    const resolvedStaticPath = resolveVSCodeStaticPathForRoot(candidate);
    if (resolvedStaticPath) {
      return resolvedStaticPath;
    }
  }

  const assetsRoot = getBackendAssetsRoot();
  return join(assetsRoot, 'vscode-web-dist');
}

export function getBackendVSCodeWorkbenchPath(): string {
  return join(
    getBackendVSCodeStaticPath(),
    'out',
    'vs',
    'code',
    'browser',
    'workbench',
    'workbench.html',
  );
}

export function getBackendHelperPath(...segments: string[]): string {
  return join(getBackendRuntimeRoot(), ...segments);
}
