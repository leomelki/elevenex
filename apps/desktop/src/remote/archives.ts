import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendRelease } from '../backend/release';
import { downloadBackend, type DownloadProgress } from '../backend/download';
import { extractBackend } from '../backend/archive';
import { failure } from './failure';

export interface PreparedArchive { readonly path: string; readonly digest: string; readonly bytes: number }
export type PrepareRemoteArchive = (release: BackendRelease, signal: AbortSignal, progress: (value: DownloadProgress) => void) => Promise<PreparedArchive>;

export async function archiveFor(root: string, release: BackendRelease, signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<{ path: string; digest: string; bytes: number }> {
  const cache = join(root, 'remote-archives');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const path = join(cache, `${release.tag}-${release.target}.tar.gz`);
  try {
    const marker = await stat(`${path}.sha256`); const artifact = await stat(path);
    if (!marker.isFile() || marker.size !== 64 || !artifact.isFile() || artifact.size < 1 || artifact.size > 1024 * 1024 * 1024) throw new Error('Invalid cached archive');
    const digest = await readFile(`${path}.sha256`, 'utf8');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
    if (/^[a-f0-9]{64}$/.test(digest) && hash.digest('hex') === digest) return { path, digest, bytes: (await stat(path)).size };
  } catch { signal.throwIfAborted(); }
  const staging = await mkdtemp(join(cache, '.download-'));
  try {
    const archive = join(staging, 'runtime.tar.gz');
    const digest = await downloadBackend(release, archive, signal, progress);
    // Reuse the local installer's path/type/size validation before remote tar
    // ever sees these bytes. The publisher's archives contain no symlinks.
    await extractBackend(archive, join(staging, 'verified'), signal);
    signal.throwIfAborted();
    await rename(archive, path);
    const marker = join(staging, 'sha256');
    await writeFile(marker, digest, { mode: 0o600 });
    await rename(marker, `${path}.sha256`);
    return { path, digest, bytes: (await stat(path)).size };
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : '';
    if (/HTTP (404|403|401)/.test(message)) throw failure('download', 'compatibility', `The backend runtime for ${release.target} is not available for this desktop revision. Use a desktop release with a published matching runtime.`, 'edit');
    if (/checksum|archive|PAX|tar|expanded|unsafe|traversal/i.test(message)) throw failure('download', 'compatibility', 'The runtime archive failed validation. No remote installation was changed. Check the published release before retrying.', 'edit');
    throw error;
  } finally { await rm(staging, { recursive: true, force: true, maxRetries: 3 }); }
}

interface ArchiveOwner {
  readonly signal: AbortSignal;
  readonly progress: (value: DownloadProgress) => void;
  readonly resolve: (archive: PreparedArchive) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
}
interface ArchiveJob {
  readonly controller: AbortController;
  readonly owners: Set<ArchiveOwner>;
  operation: Promise<void>;
  progress?: DownloadProgress;
}

/** One application owner shares expensive downloads/hash/extraction across hosts. */
export class RemoteArchiveCache {
  private readonly jobs = new Map<string, ArchiveJob>();
  private disposed = false;
  constructor(private readonly root: string, private readonly worker: typeof archiveFor = archiveFor) {}

  async prepare(release: BackendRelease, signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<PreparedArchive> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('Remote archive cache is shutting down');
    const key = `${release.tag}-${release.target}`;
    let job = this.jobs.get(key);
    if (job?.controller.signal.aborted) {
      const previous = job;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
        signal.addEventListener('abort', aborted, { once: true });
        void previous.operation.then(() => { signal.removeEventListener('abort', aborted); resolve(); });
        if (signal.aborted) aborted();
      });
      return this.prepare(release, signal, progress);
    }
    if (!job) {
      job = { controller: new AbortController(), owners: new Set(), operation: Promise.resolve() };
      this.jobs.set(key, job);
      const current = job;
      current.operation = Promise.resolve().then(() => {
        current.controller.signal.throwIfAborted();
        return this.worker(this.root, release, current.controller.signal, value => {
          current.progress = { ...value };
          for (const owner of current.owners) { try { owner.progress({ ...value }); } catch { /* A closing subscriber cannot cancel other hosts. */ } }
        });
      }).then(archive => this.settle(key, current, archive), error => this.settle(key, current, undefined, error));
    }
    const current = job;
    return new Promise<PreparedArchive>((resolve, reject) => {
      const abort = () => {
        current.owners.delete(owner); signal.removeEventListener('abort', abort); reject(signal.reason);
        if (!current.owners.size) current.controller.abort();
      };
      const owner: ArchiveOwner = { signal, progress, resolve, reject, abort };
      current.owners.add(owner); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (current.progress) { try { progress({ ...current.progress }); } catch { /* Subscriber isolation. */ } }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job => job.operation));
  }

  private settle(key: string, job: ArchiveJob, archive?: PreparedArchive, error?: unknown): void {
    if (this.jobs.get(key) === job) this.jobs.delete(key);
    for (const owner of job.owners) {
      owner.signal.removeEventListener('abort', owner.abort);
      if (archive && !job.controller.signal.aborted) owner.resolve(archive); else owner.reject(error ?? job.controller.signal.reason);
    }
    job.owners.clear();
  }
}

