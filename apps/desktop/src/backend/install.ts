import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractBackend } from './archive';
import { downloadBackend, type DownloadProgress, type Fetch } from './download';
import type { BackendRelease } from './release';

export interface InstalledBackend {
  readonly directory: string;
  readonly executable: string;
  readonly entry: string;
}

function paths(directory: string, target: string): InstalledBackend {
  const backend = join(directory, 'backend');
  return {
    directory: backend,
    entry: join(backend, 'main.cjs'),
    executable: target.startsWith('windows-') ? join(backend, 'node/node.exe') : join(backend, 'node/bin/node'),
  };
}

async function validate(installation: InstalledBackend): Promise<void> {
  for (const path of [installation.entry, installation.executable]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Backend installation is incomplete');
  }
  await access(installation.executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
}

/** One application owner calls this; no old runtime is deleted during an update. */
export async function installBackend(
  root: string, release: BackendRelease, signal: AbortSignal,
  progress: (phase: 'downloading' | 'extracting', value?: DownloadProgress) => void,
  request?: Fetch,
): Promise<InstalledBackend> {
  const versions = join(root, 'runtimes');
  const directory = join(versions, `${release.tag}-${release.target}`);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  try {
    const marker: unknown = JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8'));
    if (!marker || typeof marker !== 'object' || !('version' in marker) || marker.version !== release.version
      || !('target' in marker) || marker.target !== release.target
      || !('sha256' in marker) || typeof marker.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sha256)) {
      throw new Error('Invalid backend installation marker');
    }
    const installation = paths(directory, release.target);
    await validate(installation);
    return installation;
  } catch (error) {
    signal.throwIfAborted();
    // Only a cache miss or invalid installation is repairable. Permission errors
    // must not make us remove an otherwise usable runtime.
    if (error instanceof Error && 'code' in error && !['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw error;
  }

  const staging = await mkdtemp(join(versions, '.install-'));
  try {
    const archive = join(staging, 'runtime.tar.gz');
    progress('downloading', { receivedBytes: 0, totalBytes: null });
    const sha256 = await downloadBackend(release, archive, signal, value => progress('downloading', value), request);
    progress('extracting');
    await extractBackend(archive, staging, signal);
    await rm(archive);
    await validate(paths(staging, release.target));
    await writeFile(join(staging, 'installation.json'), JSON.stringify({ version: release.version, target: release.target, sha256 }), { mode: 0o600 });
    signal.throwIfAborted();
    // Downloads and validation finish before replacing a damaged cache entry.
    // Each revision has its own directory; updates never touch the previous one.
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    await rename(staging, directory);
    return paths(directory, release.target);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}
