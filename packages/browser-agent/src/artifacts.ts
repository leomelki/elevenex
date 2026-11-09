import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath,
  opendir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, isAbsolute, relative } from 'node:path';

/** Only this owner can create filesystem entries. Agent paths are logical names
 * below a private root, never paths relative to Electron/the backend checkout. */
export class BrowserArtifacts {
  private directory?: Promise<string>;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<void>;
  onViolation?: (message: string) => void;
  constructor(private readonly suppliedRoot?: string) {}
  root(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Artifact owner closed'));
    return (this.directory ??= (
      this.suppliedRoot
        ? Promise.resolve(this.suppliedRoot)
        : mkdtemp(join(tmpdir(), 'elevenex-playwright-'))
    ).then(async (path) => {
      const root = await realpath(path);
      this.timer = setInterval(() => {
        this.checking ??= this.checkBudget(root)
          .catch(() => {
            if (!this.closed)
              this.onViolation?.(
                'Browser artifacts exceeded their private storage budget',
              );
          })
          .finally(() => {
            this.checking = undefined;
          });
      }, 1000);
      this.timer.unref();
      return root;
    }));
  }
  async path(name: unknown, writing = false): Promise<string> {
    if (typeof name !== 'string' || !name || name.length > 512)
      throw new Error('Use an artifact name, not a host path');
    if (isAbsolute(name)) {
      const root = await this.root();
      if (!name.startsWith(root + sep))
        throw new Error('Host path is outside this artifact owner');
      name = relative(root, name).split(sep).join('/');
    }
    if (
      typeof name !== 'string' ||
      /^[A-Za-z]:/u.test(name) ||
      name.includes('\\')
    )
      throw new Error('Use an artifact name, not a host path');
    const pieces = name.split('/');
    if (
      pieces.some(
        (piece) =>
          !piece ||
          piece === '.' ||
          piece === '..' ||
          /[\p{Cc}:]/u.test(piece) ||
          /[. ]$/u.test(piece) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(piece),
      )
    )
      throw new Error('Invalid artifact path');
    const root = await this.root(),
      target = resolve(root, ...pieces);
    if (!target.startsWith(root + sep))
      throw new Error('Artifact path escaped its owner');
    let parent = root;
    for (const piece of pieces.slice(0, -1)) {
      parent = join(parent, piece);
      if (writing)
        await mkdir(parent, { recursive: false }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          },
        );
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Artifact parent is not a private directory');
    }
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error('Artifact must be a regular file');
    return target;
  }
  async write(name: unknown, bytes: Buffer | string): Promise<unknown> {
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024)
      throw new Error('Artifact exceeds 16 MiB');
    const path = await this.path(name, true);
    await writeFile(path, bytes, { mode: 0o600 });
    return { name, bytes: Buffer.byteLength(bytes) };
  }
  async read(name: unknown): Promise<Buffer> {
    const path = await this.path(name),
      stat = await lstat(path);
    if (stat.size > 16 * 1024 * 1024)
      throw new Error('Artifact exceeds 16 MiB');
    return readFile(path);
  }
  private async checkBudget(root: string): Promise<void> {
    let bytes = 0,
      entries = 0;
    const pending = [root];
    while (pending.length && !this.closed) {
      const directory = await opendir(pending.pop()!).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        },
      );
      if (!directory) continue;
      for await (const entry of directory) {
        if (++entries > 256 || entry.isSymbolicLink())
          throw new Error('Artifact entry budget');
        const path = join(directory.path, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) {
          const stat = await lstat(path).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return null;
            },
          );
          bytes += stat?.size ?? 0;
        }
        if (bytes > 128 * 1024 * 1024) throw new Error('Artifact byte budget');
      }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const root = await this.directory?.catch(() => undefined);
    await this.checking;
    if (root)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
  }
}

export function imageSize(bytes: Buffer): {
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg';
} {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      mimeType: 'image/png',
    };
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++]!;
      if (marker === 216 || marker === 217 || marker === 0) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      )
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
          mimeType: 'image/jpeg',
        };
      offset += length;
    }
  }
  throw new Error('emitImage requires a PNG or JPEG Buffer');
}
