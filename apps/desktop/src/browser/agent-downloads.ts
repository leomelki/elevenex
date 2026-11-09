import type { DownloadItem } from 'electron';
import type { BrowserAgentDownload } from '@elevenex/browser-agent';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Page-owned native downloads, separate from the human's Save dialog. */
export class AgentDownloads {
  private opening?: Promise<string>;
  private root?: string;
  private disposed = false;
  private readonly listeners = new Set<
    (download: BrowserAgentDownload) => void
  >();
  private readonly pending = new Set<DownloadItem>();
  async prepare(): Promise<void> {
    this.root = await (this.opening ??= mkdtemp(
      join(tmpdir(), 'elevenex-agent-downloads-'),
    ));
    if (this.disposed) {
      await rm(this.root, { recursive: true, force: true });
      throw new Error('Page closed');
    }
  }
  subscribe(listener: (download: BrowserAgentDownload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  accept(item: DownloadItem): boolean {
    if (
      this.disposed ||
      !this.root ||
      !this.listeners.size ||
      this.pending.size >= 2
    )
      return false;
    this.pending.add(item);
    const path = join(this.root, randomUUID());
    item.setSavePath(path);
    const finished = new Promise<string>((resolve, reject) => {
      item.on('updated', () => {
        if (
          item.getReceivedBytes() > 32 * 1024 * 1024 ||
          item.getTotalBytes() > 32 * 1024 * 1024
        )
          item.cancel();
      });
      item.once('done', (_event, state) => {
        this.pending.delete(item);
        if (state === 'completed') resolve(path);
        else reject(new Error('Download cancelled or interrupted'));
      });
    });
    // The bridge subscribes before allowing downloads and takes ownership of the
    // settled file, copying it into its own confined artifact directory.
    const download: BrowserAgentDownload = {
      url: item.getURL(),
      filename: item
        .getFilename()
        .replace(/[\p{Cc}/\\:]/gu, '_')
        .slice(0, 200),
      path: () => finished,
      cancel: () => {
        item.cancel();
        return Promise.resolve();
      },
      dispose: async () => {
        await finished.catch(() => undefined);
        await unlink(path).catch(() => undefined);
      },
    };
    for (const listener of this.listeners) listener(download);
    return true;
  }
  dispose(): void {
    this.disposed = true;
    for (const item of this.pending) item.cancel();
    this.pending.clear();
    this.listeners.clear();
    void this.opening
      ?.then((root) => rm(root, { recursive: true, force: true }))
      .catch(() => undefined);
  }
}
