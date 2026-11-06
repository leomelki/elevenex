import type { TransferState } from './web/contracts';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, number, string } from './validation';
import { taskPath, transferName, transferStat, TRANSFER_CHUNK, TRANSFER_MAX_FILE, type TransferDialogs, type TransferOperation } from './transfer-contracts';

type Call = (operation: TransferOperation, input: object, signal: AbortSignal) => Promise<unknown>;
interface Job { readonly state: TransferState; readonly controller: AbortController; touched: number; done?: Promise<void> }
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const sameFile = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
/** One user-initiated transfer per editor. Local paths come only from native dialogs;
 * neither the extension nor backend can supply a desktop filesystem capability. */
export class CodeTransfers {
  private job?: Job;
  constructor(private readonly dialogs: TransferDialogs, private readonly call: Call) {}
  dispose(): void { this.job?.controller.abort(); }
  start(input: Record<string, unknown>): { id: string } {
    if (this.job?.state.phase === 'running') throw new Error('A transfer is already running in this editor.');
    const direction = input['direction'];
    if (direction !== 'upload' && direction !== 'upload-folder' && direction !== 'download') throw new Error('Invalid transfer action.');
    if (!Array.isArray(input['paths']) || !input['paths'].length || input['paths'].length > 200) throw new Error('Select between 1 and 200 resources.');
    const paths = [...new Set(input['paths'].map(taskPath))];
    if (direction !== 'download' && paths.length !== 1) throw new Error('Choose one upload folder.');
    const controller = new AbortController(), id = randomUUID();
    const job: Job = { state: { id, phase: 'running', files: 0, skipped: 0, bytes: 0, size: 0, name: direction === 'download' ? 'Choose destination…' : 'Choose files…' }, controller, touched: Date.now() };
    this.job = job;
    job.done = this.run(job, direction, paths).then(() => { job.state.phase = controller.signal.aborted ? 'cancelled' : 'complete'; }, error => {
      job.state.phase = controller.signal.aborted && !(error instanceof TransferError && error.outcomeUnknown) ? 'cancelled' : 'failed';
      // Only deliberate domain errors are public; OS errors may contain local paths.
      job.state.message = error instanceof TransferError ? error.message : 'Transfer could not finish. Completed files were kept; incomplete files were discarded. Check the connection and file permissions before trying again.';
    });
    return { id };
  }
  status(id: unknown, cancel = false): TransferState {
    if (!this.job || string(id, 36) !== this.job.state.id) throw new Error('Transfer no longer exists.');
    if (cancel) this.job.controller.abort();
    this.job.touched = Date.now(); return { ...this.job.state };
  }
  private async run(job: Job, direction: string, paths: readonly string[]): Promise<void> {
    const signal = job.controller.signal;
    // Stop an abandoned job if its extension has gone away, including while a
    // native picker remains open. Polling renews this lease, never a mutation.
    const timer = setInterval(() => { if (Date.now() - job.touched > 60_000) job.controller.abort(); }, 10_000).unref();
    let visited = 0, total = 0, downloaded = 0;
    let replacement: 'replace-all' | 'skip-all' | undefined;
    const check = (depth = 0) => { signal.throwIfAborted(); if (++visited > 10_000 || depth > 64) throw new TransferError('Transfer exceeds 10,000 entries or 64 folder levels. Completed files were kept.'); };
    const budget = (size: number, name: string) => {
      if (size > TRANSFER_MAX_FILE || total + size > 10 * 1024 ** 3) throw new TransferError('Transfers support up to 2 GiB per file and 10 GiB in total. Completed files were kept.');
      total += size; job.state.size = size; job.state.bytes = 0; job.state.name = name;
    };
    const invoke = async (operation: TransferOperation, input: object) => { signal.throwIfAborted(); return this.call(operation, input, signal); };
    const replace = async (name: string) => {
      const choice = replacement ?? await this.dialogs.replace(name); signal.throwIfAborted();
      if (choice === 'cancel') { job.controller.abort(); signal.throwIfAborted(); }
      if (choice === 'replace-all' || choice === 'skip-all') replacement = choice;
      if (choice === 'skip' || choice === 'skip-all') { job.state.skipped++; return false; }
      return true;
    };
    const upload = async (local: string, target: string, depth = 0): Promise<void> => {
      check(depth);
      const info = await lstat(local);
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) { job.state.skipped++; return; }
      const current = transferStat(await invoke('transfer-stat', { path: target }));
      if (info.isDirectory()) {
        if (current.exists && current.type !== 2) throw new TransferError('A file blocks the selected upload folder. Choose another destination.');
        if (!current.exists) await invoke('mkdir', { path: target });
        const directory = await opendir(local);
        for await (const item of directory) {
          if (item.name.toLowerCase() === '.git' || item.name.startsWith('.elevenex-save-')) { job.state.skipped++; continue; }
          await upload(join(local, item.name), target.replace(/\/$/, '') + '/' + transferName(item.name), depth + 1);
        }
        return;
      }
      if (current.exists && current.type !== 1) throw new TransferError('A folder blocks an uploaded file. Choose another destination.');
      if (current.exists && !await replace(target)) return;
      budget(info.size, target);
      const file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let id: string | undefined;
      try {
        if (!sameFile(info, await file.stat())) throw new TransferError('A source file changed. Try uploading it again when its writer finishes.');
        id = string(object(await invoke('upload-begin', { path: target, size: info.size, revision: current.revision }))['id'], 36);
        let offset = 0;
        while (offset < info.size) {
          const bytes = Buffer.alloc(Math.min(TRANSFER_CHUNK, info.size - offset));
          let received = 0;
          while (received < bytes.length) { const result = await file.read(bytes, received, bytes.length - received, offset + received); if (!result.bytesRead) throw new TransferError('A source file changed during upload.'); received += result.bytesRead; signal.throwIfAborted(); }
          const reply = object(await invoke('upload-chunk', { id, offset, content: bytes.toString('base64') }));
          offset += bytes.length; if (number(reply['offset'], info.size) !== offset) throw new Error('Invalid upload acknowledgement.');
          job.state.bytes = offset;
        }
        if (!sameFile(info, await file.stat())) throw new TransferError('A source file changed during upload. Try again when its writer finishes.');
        await invoke('upload-commit', { id }); id = undefined; job.state.files++;
      } finally {
        await file.close();
        if (id) await this.call('upload-abort', { id }, AbortSignal.timeout(5000)).catch(() => undefined);
      }
    };
    const download = async (path: string, local: string, depth = 0): Promise<void> => {
      check(depth);
      const info = transferStat(await invoke('transfer-stat', { path }));
      if (!info.exists) throw new TransferError('A selected file no longer exists. Refresh the Explorer and try again.');
      if (info.type === 2) {
        await mkdir(local);
        let after: string | null = null;
        do {
          const page = object(await invoke('directory', { path, ...(after ? { after } : {}) }));
          if (!Array.isArray(page['entries']) || page['entries'].length > 200) throw new Error('Invalid directory page.');
          for (const raw of page['entries']) { const entry = object(raw), name = transferName(entry['name']); await download(path.replace(/\/$/, '') + '/' + name, join(local, name), depth + 1); }
          const next = page['next'] === null ? null : string(page['next']);
          if (next !== null && (after !== null && next <= after || !page['entries'].length)) throw new Error('Directory cursor did not advance.');
          after = next;
        } while (after !== null);
        return;
      }
      budget(info.size, path);
      const file = await open(local, 'wx', 0o600);
      try {
        let offset = 0;
        do {
          const raw = object(await invoke('transfer-read', { path, revision: info.revision, offset }));
          const content = string(raw['content'], Math.ceil(TRANSFER_CHUNK / 3) * 4);
          if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Invalid download bytes.');
          const bytes = Buffer.from(content, 'base64'), next = number(raw['offset'], info.size);
          if (bytes.length > TRANSFER_CHUNK || next !== offset + bytes.length || next === offset && offset < info.size) throw new Error('Invalid download offset.');
          await file.writeFile(bytes); offset = next; job.state.bytes = offset;
        } while (offset < info.size);
        await file.sync(); downloaded++;
      } finally { await file.close(); }
    };
    try {
      if (direction !== 'download') {
        const folder = transferStat(await invoke('transfer-stat', { path: paths[0]! }));
        if (!folder.exists || folder.type !== 2) throw new TransferError('Select an existing task folder for uploads.');
        const sources = await this.dialogs.upload(direction === 'upload-folder'); signal.throwIfAborted();
        if (!sources.length) { job.controller.abort(); return; }
        if (sources.length > 200) throw new TransferError('Select up to 200 files at a time, or upload a folder.');
        for (const source of sources) await upload(source, paths[0]!.replace(/\/$/, '') + '/' + transferName(basename(source)));
      } else {
        // Parent selections subsume descendants, avoiding duplicate transfers.
        const selected = paths.filter(path => !paths.some(parent => parent !== path && (parent === '/' || path.startsWith(parent + '/'))));
        const directory = selected.length > 1 ? await this.dialogs.downloadDirectory() : undefined;
        signal.throwIfAborted();
        if (selected.length > 1 && !directory) { job.controller.abort(); return; }
        for (const path of selected) {
          const name = path === '/' ? 'task-workspace' : transferName(path.split('/').at(-1));
          const target = directory ? join(directory, name) : await this.dialogs.download(name); signal.throwIfAborted();
          if (!target) { job.controller.abort(); return; }
          const parent = await realpath(dirname(target)), destination = join(parent, basename(target));
          const before = await lstat(destination).catch(error => { if (missing(error)) return null; throw error; });
          if (before && (!before.isFile() || before.isSymbolicLink())) throw new TransferError('Choose a new name when downloading a folder. Existing folders and symbolic links are never replaced.');
          if (directory && before && !await replace(name)) continue;
          const stage = await mkdtemp(join(parent, '.elevenex-save-'));
          try {
            const payload = join(stage, 'payload');
            await download(path, payload); signal.throwIfAborted();
            const info = await lstat(payload);
            if (info.isDirectory() && before) throw new TransferError('Choose a new name for the downloaded folder.');
            const latest = await lstat(destination).catch(error => { if (missing(error)) return null; throw error; });
            if (before ? !latest || !sameFile(before, latest) : latest !== null) throw new TransferError('The download destination changed. Choose a new destination and try again.');
            if (info.isDirectory() || before) await rename(payload, destination); else await link(payload, destination);
            job.state.files = downloaded;
          } finally { await rm(stage, { recursive: true, force: true }); }
        }
      }
    } finally { clearInterval(timer); }
  }
}
export class TransferError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) { super(message); }
}
