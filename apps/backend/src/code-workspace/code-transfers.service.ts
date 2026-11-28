import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants } from 'node:fs';
import { access, copyFile, link, lstat, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeWorkspace } from './code-authorization.service.js';
import { confinedPath, isMissing } from './code-files.js';
import { codePath, codeText } from './code-values.js';

export const TRANSFER_CHUNK = 256 * 1024;
export const TRANSFER_MAX_FILE = 2 * 1024 * 1024 * 1024;
interface Upload {
  readonly workspace: string;
  readonly path: string;
  readonly directory: string;
  readonly size: number;
  readonly revision: string | null;
  offset: number;
  at: number;
}
const conflict = () => new ConflictException({ code: 'file-conflict', message: 'File changed during transfer. Review it before trying again.' });
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new BadRequestException('Invalid transfer size or offset.');
  return value;
}
function stamp(info: Awaited<ReturnType<typeof lstat>>): string {
  return createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')).digest('hex');
}
/** Transfer revisions are metadata snapshots, distinct from the editor's content digests.
 * Only commit publishes bytes; chunks live outside the repository and expire. */
@Injectable()
export class CodeTransfers implements OnModuleDestroy {
  private readonly uploads = new Map<string, Upload>();
  private readonly timer = setInterval(() => { void this.expire(); }, 30_000).unref();
  private disposed = false;
  async onModuleDestroy(): Promise<void> { this.disposed = true; clearInterval(this.timer); await Promise.all([...this.uploads.keys()].map(id => this.remove(id))); }
  async release(identity: string): Promise<void> { await Promise.all([...this.uploads].filter(([, upload]) => upload.workspace === identity).map(([id]) => this.remove(id))); }
  async stat(workspace: CodeWorkspace, value: unknown) {
    try {
      const actual = await confinedPath(workspace, value), info = await lstat(actual);
      if (!info.isFile() && !info.isDirectory()) throw new BadRequestException('Only regular files and folders can be transferred.');
      return { exists: true as const, type: info.isDirectory() ? 2 : 1, size: info.size, revision: stamp(info) };
    } catch (error) { if (isMissing(error)) return { exists: false as const, type: 0, size: 0, revision: null }; throw error; }
  }
  async read(workspace: CodeWorkspace, input: Record<string, unknown>, signal: AbortSignal) {
    const actual = await confinedPath(workspace, input.path), offset = integer(input.offset, TRANSFER_MAX_FILE);
    const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > TRANSFER_MAX_FILE) throw new BadRequestException('Transfers support regular files up to 2 GiB.');
      if (stamp(info) !== input.revision || offset > info.size) throw conflict();
      signal.throwIfAborted();
      const bytes = Buffer.alloc(Math.min(TRANSFER_CHUNK, info.size - offset));
      let received = 0;
      while (received < bytes.length) {
        const { bytesRead } = await file.read(bytes, received, bytes.length - received, offset + received);
        if (!bytesRead) throw conflict();
        received += bytesRead; signal.throwIfAborted();
      }
      if (stamp(await file.stat()) !== input.revision || (await this.stat(workspace, input.path)).revision !== input.revision) throw conflict();
      return { content: bytes.toString('base64'), offset: offset + bytes.length };
    } finally { await file.close(); }
  }
  async begin(workspace: CodeWorkspace, input: Record<string, unknown>) {
    if (this.disposed || this.uploads.size >= 16 || [...this.uploads.values()].filter(upload => upload.workspace === workspace.identity).length >= 4) throw new BadRequestException('Too many active uploads.');
    const path = codePath(input.path), size = integer(input.size, TRANSFER_MAX_FILE);
    if (path === '/' || path.split('/').some(part => part.startsWith('.elevenex-save-'))) throw new BadRequestException('Invalid upload destination.');
    await confinedPath(workspace, path, true);
    const revision = input.revision === null ? null : codeText(input.revision, 64);
    if (revision !== null && !/^[a-f0-9]{64}$/.test(revision)) throw new BadRequestException('Invalid transfer revision.');
    const current = await this.stat(workspace, path);
    if ((current.exists ? current.revision : null) !== revision || current.exists && current.type !== 1) throw conflict();
    const id = randomUUID(), directory = await mkdtemp(join(tmpdir(), 'elevenex-code-upload-'));
    try {
      const file = await open(join(directory, 'bytes'), 'wx', 0o600); await file.close();
      if (this.disposed) throw new BadRequestException('Transfers stopped.');
      this.uploads.set(id, { workspace: workspace.identity, path, directory, size, revision, offset: 0, at: Date.now() });
      return { id };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async append(workspace: CodeWorkspace, input: Record<string, unknown>, signal: AbortSignal) {
    const upload = this.get(workspace, input.id), offset = integer(input.offset, TRANSFER_MAX_FILE);
    const content = codeText(input.content, Math.ceil(TRANSFER_CHUNK / 3) * 4);
    if (!content || content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new BadRequestException('Invalid transfer bytes.');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length > TRANSFER_CHUNK || offset !== upload.offset || offset + bytes.length > upload.size) throw new BadRequestException('Upload chunk is out of sequence.');
    const file = await open(join(upload.directory, 'bytes'), constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      signal.throwIfAborted();
      let written = 0;
      while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error('Upload could not be written.'); written += result.bytesWritten; signal.throwIfAborted(); }
      upload.offset += bytes.length; return { offset: upload.offset };
    } finally { await file.close(); }
  }
  async commit(workspace: CodeWorkspace, input: Record<string, unknown>, assertCurrent: () => Promise<void>, signal: AbortSignal) {
    const id = codeText(input.id, 36), upload = this.get(workspace, id);
    if (upload.offset !== upload.size) throw new BadRequestException('Upload is incomplete.');
    const path = await confinedPath(workspace, upload.path, true), temporary = join(dirname(path), '.elevenex-save-' + randomUUID());
    try {
      const current = await this.stat(workspace, upload.path);
      if ((current.exists ? current.revision : null) !== upload.revision) throw conflict();
      const info = current.exists ? await lstat(path) : null;
      if (info && !await access(path, constants.W_OK).then(() => true, () => false)) throw new ForbiddenException('This file is read-only.');
      await copyFile(join(upload.directory, 'bytes'), temporary, constants.COPYFILE_EXCL);
      const file = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { if (info && process.platform !== 'win32') await file.chmod(info.mode & 0o777); await file.sync(); } finally { await file.close(); }
      await assertCurrent(); await confinedPath(workspace, upload.path, true);
      const latest = await this.stat(workspace, upload.path);
      if ((latest.exists ? latest.revision : null) !== upload.revision) throw conflict();
      if (this.uploads.get(id) !== upload || this.disposed) throw new BadRequestException('Upload expired or was cancelled.');
      signal.throwIfAborted();
      if (upload.revision === null) await link(temporary, path); else await rename(temporary, path);
      return { accepted: true };
    } finally { await unlink(temporary).catch(() => undefined); await this.remove(id); }
  }
  async abort(workspace: CodeWorkspace, input: Record<string, unknown>) {
    const id = codeText(input.id, 36), upload = this.uploads.get(id);
    if (upload && upload.workspace !== workspace.identity) throw new BadRequestException('Upload belongs to another task.');
    await this.remove(id); return { accepted: true };
  }
  private get(workspace: CodeWorkspace, value: unknown): Upload {
    const upload = this.uploads.get(codeText(value, 36));
    if (!upload || upload.workspace !== workspace.identity || Date.now() - upload.at > 120_000) throw new BadRequestException('Upload expired or belongs to another task.');
    upload.at = Date.now(); return upload;
  }
  private async remove(id: string): Promise<void> { const upload = this.uploads.get(id); this.uploads.delete(id); if (upload) await rm(upload.directory, { recursive: true, force: true }); }
  private async expire(): Promise<void> { await Promise.all([...this.uploads].filter(([, upload]) => Date.now() - upload.at > 120_000).map(([id]) => this.remove(id))).catch(() => undefined); }
}
