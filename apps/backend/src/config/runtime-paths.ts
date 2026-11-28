import { existsSync } from 'fs';
import { join, resolve } from 'path';

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

export function getBackendRuntimeRoot(): string {
  const explicitRoot = getExplicitRuntimeRoot();
  if (explicitRoot) {
    return explicitRoot;
  }

  for (const candidate of resolveBackendRootCandidates()) {
    if (
      existsSync(join(candidate, 'proxy.conf.json')) ||
      existsSync(join(candidate, 'apps', 'frontend', 'proxy.conf.json'))
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

export function getBackendHelperPath(...segments: string[]): string {
  return join(getBackendRuntimeRoot(), ...segments);
}
