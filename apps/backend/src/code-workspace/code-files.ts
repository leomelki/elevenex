import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codePath, codeRevision, codeText } from './code-values.js';
import type { CodeWorkspace } from './code-authorization.service.js';

const MAX_FILE = 8 * 1024 * 1024;
const inside = (root: string, path: string) => path === root || (!relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
/** Symlinks are intentionally not traversed, including links into another task. */
export async function confinedPath(workspace: CodeWorkspace, value: unknown, missing = false): Promise<string> {
  const path = codePath(value);
  const parts = path.slice(1).split('/').filter(Boolean);
  let actual = workspace.root;
  for (let index = 0; index < parts.length; index++) {
    actual = join(actual, parts[index]);
    try {
      const info = await lstat(actual);
      if (info.isSymbolicLink() || (!info.isDirectory() && index < parts.length - 1)) throw new BadRequestException('Symbolic links cannot be opened in Code.');
      const resolved = await realpath(actual);
      if (!inside(workspace.root, resolved)) throw new BadRequestException('Path is outside this task.');
    } catch (error) {
      if (missing && index === parts.length - 1 && isMissing(error)) return actual;
      throw error;
    }
  }
  return actual;
}
export const isMissing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
export async function codeStat(workspace: CodeWorkspace, path: unknown) {
  const actual = await confinedPath(workspace, path);
  const info = await lstat(actual);
  if (!info.isFile() && !info.isDirectory()) throw new BadRequestException('Only regular files and folders are supported.');
  const readonly = info.isFile() && !await access(actual, constants.W_OK).then(() => true, () => false);
  return { type: info.isDirectory() ? 2 : 1, size: info.size, ctime: info.birthtimeMs, mtime: info.mtimeMs, ...(readonly ? { permissions: 1 } : {}) };
}
export async function codeRead(workspace: CodeWorkspace, path: unknown) {
  const actual = await confinedPath(workspace, path);
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new BadRequestException('File exceeds the 8 MiB editor limit.');
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_FILE + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new ConflictException({ code: 'file-changing', message: 'File changed while loading. Try again.' });
    if (offset !== info.size) throw new ConflictException({ code: 'file-changing', message: 'File changed while loading. Try again.' });
    const content = bytes.subarray(0, offset);
    return { content: content.toString('base64'), revision: codeRevision(content) };
  } finally { await file.close(); }
}
export async function codeDirectory(workspace: CodeWorkspace, path: unknown, after = '', signal?: AbortSignal) {
  const actual = await confinedPath(workspace, path);
  const directory = await opendir(actual);
  // Keep only the next page while iterating; never materialize an entire directory.
  const entries: { name: string; type: number }[] = [];
  let more = false;
  for await (const item of directory) {
    signal?.throwIfAborted();
    if (item.name.toLowerCase() === '.git' || item.name.startsWith('.elevenex-save-') || item.name <= after || (!item.isFile() && !item.isDirectory())) continue;
    const entry = { name: item.name, type: item.isDirectory() ? 2 : 1 };
    if (entries.length < 201) { entries.push(entry); if (entries.length === 201) entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); continue; }
    more = true;
    if (entry.name >= entries[200].name) continue;
    let low = 0, high = entries.length;
    while (low < high) { const middle = (low + high) >>> 1; if (entries[middle].name < entry.name) low = middle + 1; else high = middle; }
    entries.splice(low, 0, entry); entries.pop();
  }
  if (entries.length < 201) entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  more ||= entries.length > 200;
  const page = entries.slice(0, 200);
  return { entries: page, next: more ? page.at(-1)!.name : null };
}
export async function codeWrite(workspace: CodeWorkspace, input: Record<string, unknown>, assertCurrent: () => Promise<void>, signal?: AbortSignal) {
  const path = await confinedPath(workspace, input.path, true);
  if (path === workspace.root) throw new BadRequestException('Cannot replace the workspace.');
  const encoded = codeText(input.content, Math.ceil(MAX_FILE / 3) * 4);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new BadRequestException('Invalid file bytes.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_FILE) throw new BadRequestException('File exceeds the 8 MiB editor limit.');
  const expected = input.revision === null ? null : codeText(input.revision, 64);
  if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) throw new BadRequestException('A file revision is required.');
  let current: Awaited<ReturnType<typeof codeRead>> | null = null;
  try { current = await codeRead(workspace, input.path); } catch (e) { if (!isMissing(e)) throw e; }
  // A repeated save is safe to acknowledge only when the requested bytes are already present.
  const revision = codeRevision(bytes);
  if (current?.revision === revision) return { revision };
  if ((current?.revision ?? null) !== expected) throw new ConflictException({ code: 'file-conflict', message: 'File changed on disk. Compare your unsaved copy before saving.' });
  const temporary = join(dirname(path), '.elevenex-save-' + randomUUID());
  const info = await lstat(path).catch(e => { if (isMissing(e)) return null; throw e; });
  if (info && !await access(path, constants.W_OK).then(() => true, () => false)) throw new ForbiddenException('This file is read-only.');
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    // open() applies the process umask; restore existing permissions explicitly
    // so saving a shared file does not silently remove group write access.
    if (info && process.platform !== 'win32') await file.chmod(info.mode & 0o777);
    await file.sync(); await file.close();
    await assertCurrent();
    await confinedPath(workspace, input.path, true);
    let latest: string | null = null;
    try { latest = (await codeRead(workspace, input.path)).revision; } catch (e) { if (!isMissing(e)) throw e; }
    if (latest !== expected) throw new ConflictException({ code: 'file-conflict', message: 'File changed during save. Compare your unsaved copy.' });
    signal?.throwIfAborted();
    if (expected === null) {
      // Publish complete bytes without clobbering a concurrent creator or leaving
      // an empty reservation on failure. Both names are on the same filesystem.
      // Filesystems without hard-link support fail safely; never emulate this
      // with an empty destination followed by an overwriting rename.
      await link(temporary, path);
    } else await rename(temporary, path);
    return { revision };
  } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}
export async function codeMkdir(workspace: CodeWorkspace, path: unknown, signal?: AbortSignal) {
  const target = await confinedPath(workspace, path, true); signal?.throwIfAborted(); await mkdir(target); return { accepted: true };
}
export async function codeRename(workspace: CodeWorkspace, input: Record<string, unknown>, signal?: AbortSignal) {
  const source = await confinedPath(workspace, input.path), target = await confinedPath(workspace, input.target, true);
  if (source === workspace.root || target === workspace.root || basename(target).startsWith('.elevenex-save-')) throw new BadRequestException('Cannot move the workspace.');
  try { await lstat(target); throw new ConflictException({ code: 'target-exists', message: 'Destination already exists.' }); } catch (e) { if (!isMissing(e)) throw e; }
  signal?.throwIfAborted(); await rename(source, target); return { accepted: true };
}
export async function codeDelete(workspace: CodeWorkspace, input: Record<string, unknown>, signal?: AbortSignal) {
  const path = await confinedPath(workspace, input.path);
  if (path === workspace.root) throw new BadRequestException('Cannot delete the workspace.');
  const info = await lstat(path);
  if (info.isDirectory()) {
    // Nonempty recursive deletion needs a separate reviewable product action.
    signal?.throwIfAborted(); await rmdir(path);
  } else {
    const expected = codeText(input.revision, 64);
    if ((await codeRead(workspace, input.path)).revision !== expected) throw new ConflictException({ code: 'file-conflict', message: 'File changed on disk.' });
    signal?.throwIfAborted(); await unlink(path);
  }
  return { accepted: true };
}
export function publicFileError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new ConflictException({ code: 'target-exists', message: 'Destination already exists.' });
  if (isMissing(error)) throw new NotFoundException('File no longer exists.');
  throw error;
}
