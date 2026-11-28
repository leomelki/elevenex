import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BackendRelease {
  readonly version: string;
  readonly tag: string;
  readonly target: string;
  readonly archiveName: string;
  readonly url: string;
}

/** Compatibility follows the source revision, independently of the app's semver. */
export function backendRelease(metadata: unknown, platform: string, arch: string): BackendRelease {
  if (!metadata || typeof metadata !== 'object'
    || !('version' in metadata) || typeof metadata.version !== 'string'
    || !/^[a-f0-9]{40}$/i.test(metadata.version)
    || !('tag' in metadata) || typeof metadata.tag !== 'string') {
    throw new Error('Invalid bundled backend release metadata');
  }
  const { version, tag } = metadata;
  if (tag !== `runtime-${version}` && !new RegExp(`^runtime-pr-[1-9]\\d*-${version}$`).test(tag)) {
    throw new Error('Backend release tag does not match its revision');
  }
  const platforms: Readonly<Record<string, string>> = { darwin: 'macos', win32: 'windows', linux: 'linux' };
  const name = platforms[platform];
  if (!name || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported backend platform: ${platform}-${arch}`);
  const target = `${name}-${arch}`;
  const archiveName = `elevenex-backend-${target}.tar.gz`;
  return { version, tag, target, archiveName, url: `https://github.com/leomelki/elevenex/releases/download/${tag}/${archiveName}` };
}

export async function readBackendRelease(directory: string): Promise<BackendRelease> {
  const metadata: unknown = JSON.parse(await readFile(join(directory, 'backend-release.json'), 'utf8'));
  return backendRelease(metadata, process.platform, process.arch);
}
