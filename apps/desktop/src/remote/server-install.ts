import { writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadBackend, type DownloadProgress } from '../backend/download';
import { extractBackend } from '../backend/archive';
import { backendRelease, type BackendRelease } from '../backend/release';

/** Runs on the SSH host with the same HTTPS and archive validators as the client. */
export async function installFromServer(
  destination: string, release: BackendRelease, signal: AbortSignal,
  progress: (value: DownloadProgress) => void,
  download: typeof downloadBackend = downloadBackend,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const stage = await mkdtemp(join(destination, '.download-'));
    try {
      // One slow host cannot indefinitely postpone the client transfer fallback.
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      const archive = join(stage, 'archive.tar.gz');
      const digest = await download(release, archive, attemptSignal, progress);
      await extractBackend(archive, stage, attemptSignal);
      attemptSignal.throwIfAborted();
      await rename(join(stage, 'backend'), join(destination, 'backend'));
      await writeFile(join(destination, 'installation.sha256'), digest, { mode: 0o600 });
      return;
    } catch {
      signal.throwIfAborted();
      if (attempt === 2) throw new Error('Server download failed after three attempts');
    } finally {
      await rm(stage, { recursive: true, force: true, maxRetries: 3 });
    }
    await delay(1000 * 2 ** attempt, undefined, { signal });
  }
}

if (require.main === module) {
  const [, , destination, platform, arch, version, tag, nonce] = process.argv;
  if (!destination || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) process.exitCode = 1;
  else {
    const lifetime = new AbortController();
    const stop = () => lifetime.abort();
    process.once('SIGTERM', stop); process.once('SIGHUP', stop); process.once('SIGINT', stop);
    void Promise.resolve().then(() => installFromServer(destination, backendRelease({ version, tag }, platform ?? '', arch ?? ''), lifetime.signal,
      value => process.stdout.write(`EX11:${nonce}:download-progress:${value.receivedBytes}:${value.totalBytes ?? ''}\n`),
    )).catch(() => { process.exitCode = 1; }).finally(() => {
      process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop); process.removeListener('SIGINT', stop);
    });
  }
}
