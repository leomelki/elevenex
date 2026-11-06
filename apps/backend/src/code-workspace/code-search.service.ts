import { BadRequestException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { rgPath } from '@vscode/ripgrep';
import { codeLimit, codeObject, codePath, codeText } from './code-values.js';
import { confinedPath } from './code-files.js';
import type { CodeWorkspace } from './code-authorization.service.js';

interface SearchRow { path: string; line: number; start: number; end: number; text: string }
interface Search {
  workspace: string; process: ChildProcessWithoutNullStreams; rows: SearchRow[];
  done: boolean; limited: boolean; error?: string; used: number; count: number;
  wake?: () => void;
}
interface FileIndex { workspace: string; paths: string[]; dirty: boolean; limited: boolean; bytes: number; at: number; pending?: Promise<void> }
/** Search executes beside the files. Queues, subprocesses, indexes and lifetimes are bounded. */
@Injectable()
export class CodeSearch implements OnModuleDestroy {
  private readonly searches = new Map<string, Search>();
  private readonly indexes = new Map<string, FileIndex>();
  private readonly timer = setInterval(() => this.expire(), 5000).unref();
  private readonly children = new Map<ChildProcessWithoutNullStreams, string>();

  onModuleDestroy(): void {
    clearInterval(this.timer);
    for (const child of this.children.keys()) child.kill();
    for (const search of this.searches.values()) search.wake?.();
    this.searches.clear(); this.indexes.clear();
  }
  release(identity: string): void {
    for (const [id, search] of this.searches) if (search.workspace === identity) { search.process.kill(); search.done = true; search.wake?.(); this.searches.delete(id); }
    for (const [child, owner] of this.children) if (owner === identity) child.kill();
    for (const [key, index] of this.indexes) if (index.workspace === identity) this.indexes.delete(key);
  }
  invalidate(identity: string): void {
    for (const index of this.indexes.values()) if (index.workspace === identity) index.dirty = true;
  }
  cancel(workspace: CodeWorkspace, id: string): void {
    const search = this.searches.get(id);
    if (search?.workspace !== workspace.identity) return;
    search.process.kill(); search.done = true; search.wake?.(); this.searches.delete(id);
  }
  async filenames(workspace: CodeWorkspace, input: Record<string, unknown>, signal?: AbortSignal) {
    const query = codeText(input.query, 256).toLocaleLowerCase(), limit = codeLimit(input.limit);
    const folder = codePath(input.folder ?? '/'), directory = await confinedPath(workspace, folder);
    const patterns = (value: unknown): string[] => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 20) throw new BadRequestException('Too many filename patterns.'); return value.map(pattern => codeText(pattern, 256)).sort(); };
    const includes = patterns(input.includes), excludes = patterns(input.excludes);
    if (input.useIgnoreFiles !== undefined && typeof input.useIgnoreFiles !== 'boolean') throw new BadRequestException('Invalid filename ignore setting.');
    const key = JSON.stringify([workspace.identity, folder, includes, excludes, input.useIgnoreFiles !== false]);
    let index = this.indexes.get(key);
    if (!index || (!index.pending && (Date.now() - index.at > 15_000 || index.dirty && Date.now() - index.at > 1000))) {
      if (!index && this.indexes.size >= 4) {
        const oldest = [...this.indexes].find(([, value]) => !value.pending);
        if (!oldest) throw new ServiceUnavailableException('Filename indexes are busy.');
        this.indexes.delete(oldest[0]);
      }
      index = { workspace: workspace.identity, paths: [], dirty: false, bytes: 0, limited: false, at: Date.now() };
      this.indexes.set(key, index);
      const current = index;
      current.pending = this.buildIndex(workspace, current, directory, folder, includes, excludes, input.useIgnoreFiles !== false).catch(error => { if (this.indexes.get(key) === current) this.indexes.delete(key); throw error; }).finally(() => { current.pending = undefined; });
    }
    await index.pending;
    const paths: string[] = []; let bytes = 0, byteLimited = false;
    let visited = 0;
    for (const path of index.paths) {
      if (++visited % 2000 === 0) { signal?.throwIfAborted(); await yieldTurn(); }
      let position = 0;
      const lower = path.toLocaleLowerCase();
      for (const char of query) { const at = lower.indexOf(char, position); if (at < 0) { position = -1; break; } position = at + 1; }
      if (position >= 0) { const size = Buffer.byteLength(JSON.stringify(path)) + 1; if (bytes + size > 192 * 1024) { byteLimited = true; break; } bytes += size; paths.push(path); }
      if (paths.length > limit) break;
    }
    return { paths: paths.slice(0, limit), limited: byteLimited || index.limited || paths.length > limit };
  }
  async start(workspace: CodeWorkspace, input: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    for (const flag of ['regex', 'caseSensitive', 'word', 'useIgnoreFiles']) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new BadRequestException('Invalid search flag.');
    const query = codeText(input.query, 1000);
    if (!query || /[\r\n]/.test(query)) throw new BadRequestException('Enter a single-line search.');
    const limit = codeLimit(input.limit, 2000);
    const root = await confinedPath(workspace, input.folder ?? '/');
    const args = ['--no-config', '--json', '--line-buffered', '--hidden', '--no-ignore-parent', '--no-ignore-global', '--max-filesize', '8M', '--glob', '!.git/**', '--glob', '!**/.git/**', '--glob', '!.elevenex-save-*'];
    if (input.regex !== true) args.push('--fixed-strings');
    args.push(input.caseSensitive === true ? '--case-sensitive' : '--ignore-case');
    if (input.word === true) args.push('--word-regexp');
    if (input.useIgnoreFiles === false) args.push('--no-ignore');
    for (const [key, prefix] of [['includes', ''], ['excludes', '!']] as const) {
      const patterns = input[key] ?? [];
      if (!Array.isArray(patterns) || patterns.length > 20) throw new BadRequestException('Too many search patterns.');
      for (const value of patterns) { const pattern = codeText(value, 256); if (pattern) args.push('--glob', prefix + pattern); }
    }
    args.push('--iglob', '!.git', '--glob', '!.git/**', '--glob', '!**/.git/**', '--glob', '!.elevenex-save-*', '--regexp', query, '--', '.');
    // Path validation awaits filesystem work. Reserve the budget only after it,
    // with no await between checking capacity and registering the new child.
    signal?.throwIfAborted();
    if (this.searches.size >= 16 || [...this.searches.values()].filter(s => s.workspace === workspace.identity).length >= 2) throw new ServiceUnavailableException('Cancel the previous search before starting another.');
    const child = this.child(root, args, workspace.identity);
    const search: Search = { workspace: workspace.identity, process: child, rows: [], done: false, limited: false, used: Date.now(), count: 0 };
    const id = randomUUID(); this.searches.set(id, search);
    const cancelled = () => this.cancel(workspace, id);
    signal?.addEventListener('abort', cancelled, { once: true });
    child.once('close', () => signal?.removeEventListener('abort', cancelled));
    if (signal?.aborted) cancelled();
    const decoder = new StringDecoder('utf8'); let buffered = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      if (buffered.length > 2 * 1024 * 1024) { search.error = 'Search output exceeded its limit.'; child.kill(); return; }
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const event = codeObject(JSON.parse(line));
          if (event.type !== 'match') continue;
          const data = codeObject(event.data), rawPath = codeObject(data.path).text, rawText = codeObject(data.lines).text;
          if (typeof rawPath !== 'string' || typeof rawText !== 'string' || !Array.isArray(data.submatches)) continue;
          const base = codePath(input.folder ?? '/').replace(/\/$/, '');
          const path = codePath(base + '/' + rawPath.replace(/^\.\//, ''));
          for (const item of data.submatches.slice(0, 2000)) {
            const match = codeObject(item);
            if (typeof match.start !== 'number' || typeof match.end !== 'number' || typeof data.line_number !== 'number') continue;
            const bytes = Buffer.from(rawText);
            const start = bytes.subarray(0, match.start).toString().length;
            const finish = bytes.subarray(0, match.end).toString().length;
            if (search.count++ >= limit || search.rows.length >= 400) { search.limited = true; child.kill(); break; }
            // Preview windows are bounded while preserving columns for long lines.
            const offset = Math.max(0, start - 100);
            search.rows.push({ path, line: data.line_number - 1, start, end: finish, text: rawText.slice(offset, Math.max(offset + 512, Math.min(finish + 100, offset + 2048))).replace(/[\r\n]+$/, '') });
          }
        } catch (error) { if (error instanceof BadRequestException) continue; search.error = 'Invalid search output.'; child.kill(); }
      }
      if (search.rows.length >= 200) child.stdout.pause();
      search.wake?.();
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.once('error', () => { search.error = 'Search could not start. Reinstall the machine runtime.'; search.done = true; search.wake?.(); });
    child.once('close', (code, signal) => { if (code !== 0 && code !== 1 && !signal && !search.limited) search.error = stderr ? 'Search pattern is invalid or files could not be read.' : 'Search failed.'; search.done = true; search.wake?.(); });
    return this.page(workspace, id);
  }
  async page(workspace: CodeWorkspace, id: string) {
    const search = this.searches.get(id);
    if (!search || search.workspace !== workspace.identity) throw new BadRequestException('Search expired. Run it again.');
    search.used = Date.now();
    if (!search.rows.length && !search.done) await new Promise<void>(resolve => {
      const timer = setTimeout(done, 80);
      function done() { clearTimeout(timer); search!.wake = undefined; resolve(); }
      search.wake = done;
    });
    const rows: SearchRow[] = []; let bytes = 0;
    while (search.rows.length && rows.length < 100) { const row = search.rows[0]; const size = Buffer.byteLength(JSON.stringify(row)) + 1; if (rows.length && bytes + size > 192 * 1024) break; rows.push(search.rows.shift()!); bytes += size; }
    if (search.rows.length < 100) search.process.stdout.resume();
    const done = search.done && search.rows.length === 0;
    if (done) this.searches.delete(id);
    return { id, rows, done, limited: search.limited, ...(search.error ? { error: search.error } : {}) };
  }
  private child(cwd: string, args: string[], identity: string): ChildProcessWithoutNullStreams {
    const child = spawn(rgPath, args, { cwd, shell: false, windowsHide: true, stdio: 'pipe', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' } });
    child.stdin.end(); this.children.set(child, identity); child.once('close', () => this.children.delete(child));
    return child;
  }
  private async buildIndex(workspace: CodeWorkspace, index: FileIndex, directory: string, folder: string, includes: string[], excludes: string[], useIgnore: boolean): Promise<void> {
    const args = ['--no-config', '--files', '--null', '--hidden', '--no-ignore-parent', '--no-ignore-global'];
    if (!useIgnore) args.push('--no-ignore');
    for (const pattern of includes) args.push('--glob', pattern);
    for (const pattern of excludes) args.push('--glob', '!' + pattern);
    args.push('--iglob', '!.git', '--glob', '!.elevenex-save-*', '--', '.');
    const child = this.child(directory, args, workspace.identity);
    const decoder = new StringDecoder('utf8'); let buffered = '';
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += decoder.write(chunk); let end: number;
        while ((end = buffered.indexOf('\0')) >= 0) {
          const raw = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          try {
            const path = codePath(folder.replace(/\/$/, '') + '/' + raw.replace(/^\.\//, ''));
            if (index.paths.length >= 100_000 || index.bytes + path.length * 2 > 12 * 1024 * 1024) { index.limited = true; child.kill(); break; }
            index.paths.push(path); index.bytes += path.length * 2;
          } catch { /* Unsupported filenames are not editor resources. */ }
        }
      });
      child.stderr.resume(); child.once('error', reject);
      child.once('close', code => { if (code !== 0 && code !== 1 && !index.limited) reject(new ServiceUnavailableException('Filename search failed.')); else resolve(); });
    });
  }
  private expire(): void {
    for (const [id, search] of this.searches) if (Date.now() - search.used > 30_000) { search.process.kill(); search.wake?.(); this.searches.delete(id); }
    for (const [id, index] of this.indexes) if (!index.pending && Date.now() - index.at > 120_000) this.indexes.delete(id);
  }
}
