import { BadRequestException, NotFoundException } from '@nestjs/common';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeWorkspace } from './code-authorization.service.js';
import { codeDirectory, codeRead, codeStat, confinedPath, isMissing } from './code-files.js';
import { codePath, codeRevision, codeText } from './code-values.js';

const virtualPath = (path: string) => '/' + path.split(sep).join('/');
const fingerprint = (info: Awaited<ReturnType<typeof lstat>>) =>
  codeRevision(Buffer.from(JSON.stringify([info.dev, info.ino, info.birthtimeMs])));

async function physicalPath(path: string): Promise<string> {
  const root = parse(path).root;
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path)) throw new BadRequestException('Invalid local path.');
  const subpath = virtualPath(relative(root, path));
  // macOS publishes these system-owned aliases for physical paths under /private.
  const alias = process.platform === 'darwin' ? /^\/(tmp|var)(?=\/|$)/.exec(subpath)?.[0] : undefined;
  if (alias) {
    const info = await lstat(alias);
    if (info.isSymbolicLink() && info.uid === 0 && await realpath(alias) === '/private' + alias)
      return confinedPath({ root: '/private' + alias }, subpath.slice(alias.length) || '/');
  }
  return confinedPath({ root }, subpath);
}

function localPath(workspace: CodeWorkspace, text: string): string {
  if (!text || Array.from(text).some(character => character.charCodeAt(0) < 32) || /^[\\/]{2}/.test(text) ||
      (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) ||
      (/^[a-z]:[\\/]/i.test(text) && process.platform !== 'win32'))
    throw new BadRequestException('Invalid local path.');
  // Reject Git metadata before normalizing traversal, including on Windows.
  if (text.split(/[\\/]/).some(part => part.toLowerCase() === '.git'))
    throw new BadRequestException('Git metadata cannot be opened in Code.');
  return resolve(workspace.root, text);
}

export async function resolveCodeLink(workspace: CodeWorkspace, value: unknown, mode: 'markdown' | 'literal-file' = 'markdown') {
  const link = codeText(value);
  const target = async (text: string, line?: number, column?: number) => {
    const actual = await physicalPath(localPath(workspace, text));
    const info = await lstat(actual);
    if (mode === 'literal-file' && !info.isFile()) throw new NotFoundException('Changed file does not exist.');
    if (!info.isDirectory() && !info.isFile()) throw new BadRequestException('Only regular files and folders are supported.');
    const type = info.isDirectory() ? 2 : 1;
    const child = relative(workspace.root, actual);
    const position = { type, line: line ?? 1, column: column ?? 1 };
    if (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep))
      return { ...position, kind: 'workspace', path: virtualPath(child) };
    if (!basename(actual)) throw new BadRequestException('Link to a specific file or folder.');
    return { ...position, kind: 'external', path: actual, name: basename(actual), fingerprint: fingerprint(info) };
  };

  if (mode === 'literal-file') {
    // An external relative path can depend on the agent's working directory.
    // Changes carries the recorded path, so resolve only explicit absolute
    // paths and worktree-relative paths that stay under the worktree.
    const absolute = isAbsolute(link) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(link));
    if ((!absolute && /^[\\/]/.test(link)) || link.split(/[\\/]/).includes('..'))
      throw new BadRequestException('The changed file needs an unambiguous path.');
    return target(link);
  }

  let path: string;
  let fragment = '';
  try {
    if (/^file:/i.test(link)) {
      const url = new URL(link);
      if (!/^file:\/\/\//i.test(link) || url.host || url.search) throw new Error('Invalid file URL');
      path = fileURLToPath(url);
      fragment = url.hash;
    } else {
      path = decodeURIComponent(link);
    }
  } catch { throw new BadRequestException('Invalid file link.'); }

  const location = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?)$/.exec(path + fragment);
  if (!fragment) {
    try {
      // Literal filenames can contain "#" and ":" on the task's machine.
      return await target(path);
    } catch (error) {
      if (!location || !isMissing(error) && !/^[a-z][a-z\d+.-]*:\d+/.test(path) && process.platform !== 'win32') throw error;
    }
  }
  const line = Number(location?.[2] ?? location?.[4]), column = Number(location?.[3] ?? location?.[5] ?? 1);
  if (!location || !Number.isInteger(line) || line < 1 || line > 10_000_000 || !Number.isInteger(column) || column < 1 || column > 10_000_000)
    throw new BadRequestException('Invalid file position.');
  return target(location[1]!, line, column);
}

/** Only the desktop's private transport can supply a resolved external root.
 * Recheck its physical location and identity on every bounded read. */
export async function readCodeLink(operation: 'link-stat' | 'link-read' | 'link-directory', input: Record<string, unknown>, signal: AbortSignal) {
  const root = codeText(input.root);
  const path = codePath(input.path);
  if (await physicalPath(root) !== root) throw new NotFoundException('Linked path has changed.');
  const info = await lstat(root);
  if (fingerprint(info) !== input.fingerprint || !info.isDirectory() && (!info.isFile() || path !== '/'))
    throw new NotFoundException('Linked path has changed.');
  if (operation === 'link-stat') return codeStat({ root }, path);
  if (operation === 'link-read') return codeRead({ root }, path);
  return codeDirectory({ root }, path, input.after === undefined ? '' : codeText(input.after), signal);
}
