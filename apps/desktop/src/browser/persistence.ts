import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserUrl, record } from './validation';
export interface SavedBrowser { readonly active: number; readonly tabs: readonly { readonly url: string; readonly width: 'phone' | 'full'; readonly by?: 'you' | 'agent'; readonly agentSessionId?: number | null }[] }
/** Navigation metadata only, bounded per task. Cookies and form values never go into this file. */
export class BrowserPersistence {
  private readonly pending = new Map<string, SavedBrowser>();
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}
  private path(key: string): string { return join(this.root, createHash('sha256').update(key).digest('hex') + '.json'); }
  async read(key: string): Promise<SavedBrowser | null> {
    try {
      if ((await stat(this.path(key))).size > 32768) return null;
      const raw = record(JSON.parse(await readFile(this.path(key), 'utf8')) as unknown);
      if (!Array.isArray(raw['tabs']) || raw['tabs'].length > 12 || !Number.isInteger(raw['active'])) return null;
      return { active: Number(raw['active']), tabs: raw['tabs'].map(value => {
        const tab = record(value), url = new URL(browserUrl(tab['url']));
        // Queries/fragments often contain credentials. Reopening restores the safe location only.
        url.search = ''; url.hash = '';
        return { url: url.href, width: tab['width'] === 'phone' ? 'phone' as const : 'full' as const, ...(tab['by'] === 'agent' ? { by: 'agent' as const } : {}), ...(typeof tab['agentSessionId'] === 'number' && Number.isSafeInteger(tab['agentSessionId']) && tab['agentSessionId'] > 0 ? { agentSessionId: tab['agentSessionId'] } : {}) };
      }) };
    } catch { return null; }
  }
  save(key: string, value: SavedBrowser): void {
    this.pending.set(key, value);
    this.writing = this.writing.catch(() => undefined).then(async () => {
      const next = this.pending.get(key); if (!next) return;
      this.pending.delete(key); await mkdir(this.root, { recursive: true });
      const path = this.path(key), temp = path + '.tmp';
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, path);
    }).catch(() => { /* Navigation remains usable if application data is unwritable. */ });
  }
  flush(): Promise<void> { return this.writing; }
}
