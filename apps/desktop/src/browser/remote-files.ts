import { dialog, type BrowserWindow } from 'electron';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record } from './validation';
import type { TaskBrowserWorkflow } from '@elevenex/shared';

const limit = 32 * 1024 * 1024, chunkSize = 48 * 1024;
/** Native user selection and bounded, sequential file relay. Paths never cross the bridge. */
export class RemoteBrowserFiles {
  private readonly pending = new Set<string>();
  constructor(
    private readonly window: BrowserWindow,
    private readonly current: () => boolean,
    private readonly request: (body: unknown) => Promise<unknown>,
    private readonly cancel: (tabId: string, requestId: string) => Promise<void>,
    private readonly dialogs: Pick<typeof dialog, 'showOpenDialog' | 'showSaveDialog'> = dialog,
  ) {}
  async run(tabId: string, workflow: TaskBrowserWorkflow): Promise<void> {
    if (this.pending.size >= 2 || this.pending.has(workflow.id)) throw new Error('A file selection is already open');
    this.pending.add(workflow.id);
    const check = () => { if (!this.current() || this.window.isDestroyed()) throw new Error('Browser changed during file transfer'); };
    const transfer = async (body: unknown) => { check(); const reply = await this.request({ tabId, requestId: workflow.id, transfer: body }); check(); return reply; };
    try {
      check();
      if (workflow.kind === 'upload') {
        const selected = await this.dialogs.showOpenDialog(this.window, { title: 'Choose files for this site', properties: workflow.multiple ? ['openFile', 'multiSelections'] : ['openFile'] });
        check();
        if (selected.canceled) return;
        if (!selected.filePaths.length || selected.filePaths.length > 16) throw new Error('Choose at most 16 files');
        const files = [];
        try {
          let size = 0;
          for (const path of selected.filePaths) {
            const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); files.push({ file, name: [...basename(path)].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || '/\\'.includes(char) ? '_' : char).join('').slice(0, 200), size: 0 });
            const stat = await file.stat(); size += stat.size;
            if (!stat.isFile() || size > limit) throw new Error('Choose files totaling at most 32 MB');
            files[files.length - 1]!.size = stat.size;
          }
          await transfer({ kind: 'upload-start', files: files.map(({ name, size }) => ({ name, size })) });
          for (let index = 0; index < files.length; index++) {
            const { file, size } = files[index]!;
            for (let offset = 0; offset < size;) {
              const buffer = Buffer.alloc(Math.min(chunkSize, size - offset));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
              if (bytesRead !== buffer.length) throw new Error('Selected file changed during upload');
              await transfer({ kind: 'upload-chunk', index, offset, data: buffer.toString('base64') }); offset += bytesRead;
            }
          }
          await transfer({ kind: 'upload-finish' });
        } finally { await Promise.all(files.map(({ file }) => file.close())); }
      } else if (workflow.kind === 'download') {
        if (workflow.status !== 'ready') throw new Error('Wait for the download to finish');
        const selected = await this.dialogs.showSaveDialog(this.window, { title: 'Save browser download', defaultPath: basename(workflow.name.replace(/\\/g, '/')) || 'download' });
        check();
        if (selected.canceled || !selected.filePath) return;
        const path = selected.filePath, temporary = join(dirname(path), '.elevenex-download-' + randomUUID());
        const file = await open(temporary, 'wx', 0o600);
        try {
          let offset = 0, expected: number | undefined;
          for (;;) {
            const reply = record(await transfer({ kind: 'download-read', offset }));
            const size = reply['size'], data = reply['data'];
            if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > limit || (expected !== undefined && size !== expected) || reply['offset'] !== offset || typeof data !== 'string' || data.length > 65536) throw new Error('Invalid download chunk');
            expected = Number(size);
            const bytes = Buffer.from(data, 'base64');
            if (bytes.toString('base64') !== data || bytes.length !== Math.min(chunkSize, expected - offset)) throw new Error('Invalid download data');
            await file.writeFile(bytes); offset += bytes.length;
            if (offset === expected) break;
          }
          check(); await file.close(); await rename(temporary, path);
        } finally { await file.close().catch(() => undefined); await rm(temporary, { force: true }); }
      } else throw new Error('Unsupported file request');
    } finally { this.pending.delete(workflow.id); await this.cancel(tabId, workflow.id).catch(() => undefined); }
  }
}
