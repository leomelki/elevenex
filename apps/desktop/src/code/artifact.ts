import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractArchive } from '../backend/archive';

export const CODE_ARTIFACT = Object.freeze({
  version: '1.144.0',
  url: 'https://registry.npmjs.org/code-oss/-/code-oss-1.144.0.tgz',
  sha512: 'NnguaAXGGSG/fONYxzd1XDToP3q9BRczB4Cv4syjXX6ezTKCjQ0HTLWzBCGTvd51sNyrg5h9Gh39S95C/NU5Rw==',
});
const ENTRY = 'out/vs/workbench/workbench.web.main.internal.js';
/** One application owner; coalesces lazy installs, never gates machine startup. */
export class CodeArtifact {
  private pending?: Promise<string>;
  private readonly lifetime = new AbortController();
  constructor(private readonly root: string) {}
  prepare(): Promise<string> {
    return this.pending ??= this.install().catch(error => { this.pending = undefined; throw error; });
  }
  async dispose(): Promise<void> { this.lifetime.abort(); await this.pending?.catch(() => undefined); }
  private async healthy(root: string): Promise<boolean> {
    const files = [ENTRY, 'out/nls.messages.js', 'out/vs/workbench/workbench.web.main.internal.css', 'out/vs/workbench/api/worker/extensionHostWorkerMain.js', 'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html'];
    try { return (await Promise.all(files.map(file => stat(join(root, file))))).every(info => info.isFile() && info.size > 0); } catch { return false; }
  }
  private async prune(): Promise<void> {
    const versions = (await readdir(this.root)).filter(name => /^\d+\.\d+\.\d+$/.test(name) && name !== CODE_ARTIFACT.version).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of versions.slice(1)) await rm(join(this.root, name), { recursive: true, force: true });
  }
  private async install(): Promise<string> {
    const signal = this.lifetime.signal;
    const destination = join(this.root, CODE_ARTIFACT.version), assets = join(destination, 'package');
    try {
      const marker: unknown = JSON.parse(await readFile(join(destination, 'installed.json'), 'utf8'));
      if (marker && typeof marker === 'object' && 'integrity' in marker && marker.integrity === CODE_ARTIFACT.sha512 && await this.healthy(assets)) { void this.prune().catch(() => undefined); return assets; }
    } catch { signal.throwIfAborted(); }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.root)).filter(name => /^\.install-[a-zA-Z0-9]+$/.test(name)).slice(0, 32)) await rm(join(this.root, name), { recursive: true, force: true });
    const stage = await mkdtemp(join(this.root, '.install-'));
    try {
      const archive = join(stage, 'code.tgz');
      const response = await fetch(CODE_ARTIFACT.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]), redirect: 'error', credentials: 'omit' }).catch(() => { signal.throwIfAborted(); throw new Error('Code download could not complete. Check the connection and try again.'); });
      if (!response.ok || !response.body) throw new Error('Editor download failed. Check the connection and try again.');
      let size = 0;
      const hash = createHash('sha512'), file = await open(archive, 'wx', 0o600);
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 160 * 1024 * 1024) throw new Error('Editor download exceeded its limit.');
          hash.update(chunk); await file.writeFile(chunk);
        }
      } finally { await file.close(); await response.body.cancel().catch(() => undefined); }
      if (hash.digest('base64') !== CODE_ARTIFACT.sha512) throw new Error('Editor download failed integrity verification. Try again.');
      await extractArchive(archive, stage, signal, 'package', name => name.endsWith('.map') || name.startsWith('package/nls/'));
      await rm(archive);
      if (!await this.healthy(join(stage, 'package'))) throw new Error('Editor installation is incomplete. Try again.');
      await writeFile(join(stage, 'installed.json'), JSON.stringify({ integrity: CODE_ARTIFACT.sha512 }), { mode: 0o600 });
      signal.throwIfAborted();
      await rm(destination, { recursive: true, force: true }); await rename(stage, destination);
      await this.prune(); return assets;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
