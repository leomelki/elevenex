import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { developmentBackend } from '../backend/development';
import { extractBackend } from '../backend/archive';
import type { archiveFor } from './archives';
import { failure } from './failure';

/** Launcher-only archives never become an override in a packaged application. */
export function developmentRemote(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): {
  readonly release: NonNullable<ReturnType<typeof developmentBackend>>['release'];
  readonly namespace: string;
  readonly archive: typeof archiveFor;
} | undefined {
  const local = developmentBackend(isPackaged, env);
  if (!local) return undefined;
  const directory = env['ELEVENEX_DESKTOP_DEV_BACKEND'] ?? '';
  return {
    release: local.release,
    // Development databases/daemons cannot take ownership of a release's data.
    namespace: createHash('sha256').update(directory).digest('hex').slice(0, 32),
    archive: async (root, release, signal, progress) => {
      signal.throwIfAborted();
      if (!isAbsolute(directory)) throw new Error('Development backend path must be absolute');
      const descriptor = join(directory, 'remote-archive.json');
      const descriptorInfo = await stat(descriptor).catch(() => undefined);
      const metadata: unknown = descriptorInfo?.isFile() && descriptorInfo.size <= 4096 ? JSON.parse(await readFile(descriptor, 'utf8')) : null;
      if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== release.version
        || !('target' in metadata) || metadata.target !== release.target) {
        throw failure('installation', 'compatibility', `A development runtime for ${release.target} is unavailable. Build on the same OS and architecture as the server and restart pnpm desktop:dev.`, 'edit');
      }
      if (!('digest' in metadata) || typeof metadata.digest !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.digest)) throw new Error('Invalid development archive checksum');
      const path = join(directory, release.archiveName);
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > 1073741824) throw new Error('Invalid development archive size');
      const hash = createHash('sha256'); let receivedBytes = 0;
      for await (const bytes of createReadStream(path, { signal })) {
        receivedBytes += bytes.length;
        if (receivedBytes > info.size) throw new Error('Development archive changed while reading');
        hash.update(bytes);
      }
      if (receivedBytes !== info.size || hash.digest('hex') !== metadata.digest) throw new Error('Development archive checksum mismatch; restart pnpm desktop:dev');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const verified = await mkdtemp(join(root, '.development-verify-'));
      try { await extractBackend(path, verified, signal); }
      finally { await rm(verified, { recursive: true, force: true, maxRetries: 3 }); }
      signal.throwIfAborted();
      progress({ receivedBytes, totalBytes: info.size });
      return { path, digest: metadata.digest, bytes: info.size };
    },
  };
}
