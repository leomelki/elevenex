import type { Dialog, Download, FileChooser } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { TaskBrowserWorkflow } from '@elevenex/shared';

export const workflowLimit = 32 * 1024 * 1024;
export const workflowChunk = 48 * 1024;
const uploadMime: Readonly<Record<string, string>> = {
  txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown', html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', heic: 'image/heic', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
interface Pending {
  view: TaskBrowserWorkflow;
  timer: ReturnType<typeof setTimeout>;
  dialog?: Dialog;
  chooser?: FileChooser;
  download?: Download;
  file?: FileHandle;
  buffers?: { name: string; size: number; data: Buffer[]; received: number }[];
  busy?: boolean;
  release?: () => void;
}
/** Aggregate task budget, shared by all of its pages. */
export class RuntimeWorkflowBudget {
  private uploadBytes = 0;
  private uploads = 0;
  private downloads = 0;
  acquire(kind: 'upload' | 'download', bytes = 0): () => void {
    if (kind === 'upload' ? this.uploads >= 2 || this.uploadBytes + bytes > workflowLimit : this.downloads >= 2) throw new Error('Task file transfer capacity reached');
    if (kind === 'upload') { this.uploads++; this.uploadBytes += bytes; } else this.downloads++;
    let released = false;
    return () => { if (released) return; released = true; if (kind === 'upload') { this.uploads--; this.uploadBytes -= bytes; } else this.downloads--; };
  }
}
/** Page-owned, expiring requests. Only the private viewer can answer or transfer bytes. */
export class RuntimeBrowserWorkflows {
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  constructor(private readonly changed: () => void, private readonly needsUser: () => void, private readonly budget = new RuntimeWorkflowBudget(), private readonly failed: (message: string) => void = () => undefined) {}
  snapshot(): readonly TaskBrowserWorkflow[] { return [...this.pending.values()].map(item => item.view); }
  private add(view: TaskBrowserWorkflow): Pending | undefined {
    if (this.disposed || this.pending.size >= 4) return undefined;
    const timer = setTimeout(() => void this.cancel(view.id), 5 * 60_000);
    timer.unref();
    const item = { view, timer };
    this.pending.set(view.id, item);
    this.needsUser();
    this.changed();
    return item;
  }
  dialog(dialog: Dialog): void {
    const type = dialog.type();
    if (type !== 'alert' && type !== 'confirm' && type !== 'prompt' && type !== 'beforeunload') { void dialog.dismiss().catch(() => undefined); return; }
    const item = this.add({ id: randomUUID(), kind: 'dialog', type, message: dialog.message().slice(0, 4000), defaultValue: dialog.defaultValue().slice(0, 4096) });
    if (item) item.dialog = dialog;
    else void dialog.dismiss().catch(() => undefined);
  }
  upload(chooser: FileChooser): void {
    const item = this.add({ id: randomUUID(), kind: 'upload', multiple: chooser.isMultiple() });
    if (item) item.chooser = chooser;
    else void chooser.element().dispose().catch(() => undefined);
  }
  download(download: Download): void {
    if ([...this.pending.values()].filter(item => item.download).length >= 2) { this.failed('Two downloads are already waiting. Save or cancel them before downloading again.'); void download.cancel().catch(() => undefined); return; }
    const name = download.suggestedFilename().replace(/[\x00-\x1f\x7f/\\:]/g, '_').slice(0, 200) || 'download';
    const item = this.add({ id: randomUUID(), kind: 'download', name, status: 'receiving' });
    if (!item) { void download.cancel().catch(() => undefined); return; }
    try { item.release = this.budget.acquire('download'); }
    catch { this.failed('Two task downloads are already waiting. Save or cancel them before downloading again.'); this.remove(item.view.id); void download.cancel().catch(() => undefined); return; }
    item.download = download;
    void download.path().then(async path => {
      if (!path || !this.pending.has(item.view.id)) return;
      const file = await open(path, 'r');
      if (!this.pending.has(item.view.id)) { await file.close(); return; }
      item.file = file;
      if ((await file.stat()).size > workflowLimit) { await this.cancel(item.view.id); return; }
      if (!this.pending.has(item.view.id)) return;
      item.view = { id: item.view.id, kind: 'download', name, status: 'ready' };
      this.changed();
    }).catch(() => {
      if (this.pending.has(item.view.id)) this.failed('Download stopped or exceeded the 32 MB limit. Try again or use Open outside for larger files.');
      return this.cancel(item.view.id);
    });
  }
  async respond(id: string, accept: boolean, text: string): Promise<void> {
    const item = this.get(id);
    if (!item.dialog || item.busy) throw new Error('Dialog changed');
    item.busy = true;
    try { if (accept) await item.dialog.accept(text); else await item.dialog.dismiss(); }
    finally { this.remove(id); }
  }
  private get(id: string): Pending {
    const item = this.pending.get(id);
    if (!item || this.disposed) throw new Error('Site request expired');
    return item;
  }
  async transfer(id: string, input: WorkflowTransfer): Promise<unknown> {
    const item = this.get(id);
    if (item.busy) throw new Error('Transfer already in progress');
    item.busy = true;
    try {
      if (input.kind === 'upload-start') {
        if (!item.chooser || item.buffers || (!item.chooser.isMultiple() && input.files.length !== 1) || input.files.reduce((n, file) => n + file.size, 0) > workflowLimit) throw new Error('Upload exceeds bounds');
        item.release = this.budget.acquire('upload', input.files.reduce((size, file) => size + file.size, 0));
        item.buffers = input.files.map(file => ({ ...file, received: 0, data: [] }));
        return {};
      }
      if (input.kind === 'upload-chunk') {
        const file = item.buffers?.[input.index], data = Buffer.from(input.data, 'base64');
        if (!file || file.received !== input.offset || data.length > workflowChunk || data.toString('base64') !== input.data || file.received + data.length > file.size) throw new Error('Upload chunk changed');
        file.data.push(data); file.received += data.length;
        return {};
      }
      if (input.kind === 'upload-finish') {
        if (!item.chooser || !item.buffers || item.buffers.some(file => file.received !== file.size)) throw new Error('Upload incomplete');
        await item.chooser.setFiles(item.buffers.map(file => ({ name: file.name, mimeType: uploadMime[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream', buffer: Buffer.concat(file.data) })), { timeout: 15000 });
        await this.cancel(id);
        return {};
      }
      if (!item.file || item.view.kind !== 'download' || item.view.status !== 'ready') throw new Error('Download unavailable');
      const size = (await item.file.stat()).size;
      if (input.offset > size || size > workflowLimit) throw new Error('Download exceeds bounds');
      const buffer = Buffer.alloc(Math.min(workflowChunk, size - input.offset));
      const { bytesRead } = await item.file.read(buffer, 0, buffer.length, input.offset);
      return { offset: input.offset, size, data: buffer.subarray(0, bytesRead).toString('base64') };
    } finally { item.busy = false; }
  }
  private remove(id: string): void {
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.timer); item.release?.(); this.pending.delete(id); this.changed();
  }
  async cancel(id: string): Promise<void> {
    const item = this.pending.get(id);
    if (!item) return;
    this.remove(id);
    await item.dialog?.dismiss().catch(() => undefined);
    await item.chooser?.element().dispose().catch(() => undefined);
    await item.file?.close().catch(() => undefined);
    await item.download?.cancel().catch(() => undefined);
    await item.download?.delete().catch(() => undefined);
  }
  async documentChanged(): Promise<void> { await Promise.all([...this.pending.values()].filter(item => item.view.kind !== 'download').map(item => this.cancel(item.view.id))); }
  async clear(): Promise<void> { await Promise.all([...this.pending.keys()].map(id => this.cancel(id))); }
  async destroy(): Promise<void> { this.disposed = true; await this.clear(); }
}
export type WorkflowTransfer =
  | { kind: 'upload-start'; files: { name: string; size: number }[] }
  | { kind: 'upload-chunk'; index: number; offset: number; data: string }
  | { kind: 'upload-finish' }
  | { kind: 'download-read'; offset: number };
