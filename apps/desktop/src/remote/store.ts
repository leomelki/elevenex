import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EnvironmentContext, EnvironmentSelection, RemoteForwardInput, RemoteHost } from '@elevenex/shared';
import * as validate from './validation';

export interface SavedWindow {
  selection: EnvironmentSelection;
  contexts: Record<string, EnvironmentContext>;
  /** Intentional disconnect remains disconnected after relaunch. */
  connect: boolean;
  forwards: Record<string, (RemoteForwardInput & { id: string })[]>;
}
export interface RemoteSettings { hosts: RemoteHost[]; windows: SavedWindow[] }
export const emptyContext = (): EnvironmentContext => ({ projectId: null, taskId: null, sessionId: null, draft: '', cursor: null });
export const emptyWindow = (): SavedWindow => ({ selection: { kind: 'local' }, contexts: {}, connect: false, forwards: {} });
export const environmentKey = (value: EnvironmentSelection): string => value.kind === 'local' ? 'local' : value.hostId;

/** One application owner serializes atomic writes. Never stores challenge replies. */
export class RemoteSettingsStore {
  private pending: { body: string; promise: Promise<void>; resolve(): void; reject(error: unknown): void } | undefined;
  private writing = false;
  constructor(private readonly path: string) {}

  async load(): Promise<RemoteSettings> {
    try {
      if ((await stat(this.path)).size > 16 * 1024 * 1024) throw new Error('Remote settings exceed their size limit');
      const input = validate.object(JSON.parse(await readFile(this.path, 'utf8')), ['version', 'hosts', 'windows']);
      if (input['version'] !== 1 || !Array.isArray(input['hosts']) || input['hosts'].length > 100 || !Array.isArray(input['windows']) || input['windows'].length > 32) throw new Error('Invalid remote settings');
      const hosts = input['hosts'].map((value: unknown) => {
        // Older saved hosts had an app-level forwarding toggle. Discard it:
        // OpenSSH configuration is now the sole owner of forwarding policy.
        const { id, forwardAgent, ...host } = validate.object(value, ['id', 'name', 'hue', 'host', 'user', 'port', 'identityFile', 'configFile', 'forwardAgent']);
        if (forwardAgent !== undefined && typeof forwardAgent !== 'boolean') throw new Error('Invalid legacy forwarding setting');
        return { ...validate.hostInput(host), id: validate.id(id) };
      });
      if (new Set(hosts.map(host => host.id)).size !== hosts.length) throw new Error('Duplicate saved host');
      const windows = input['windows'].map((value: unknown): SavedWindow => {
        const window = validate.object(value, ['selection', 'contexts', 'connect', 'forwards']);
        const selection = validate.selection(window['selection']);
        if (selection.kind === 'remote' && !hosts.some(host => host.id === selection.hostId)) throw new Error('Unknown saved host');
        if (typeof window['connect'] !== 'boolean') throw new Error('Invalid connection intent');
        const contexts = validate.object(window['contexts'], ['local', ...hosts.map(host => host.id)]);
        const forwards = validate.object(window['forwards'], hosts.map(host => host.id));
        const saved: SavedWindow = { selection, contexts: {}, forwards: {}, connect: window['connect'] };
        for (const [key, value] of Object.entries(contexts)) saved.contexts[key] = validate.context(value);
        for (const [key, value] of Object.entries(forwards)) {
          if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid saved forwards');
          saved.forwards[key] = value.map((entry: unknown) => {
            const { id, ...input } = validate.object(entry, ['id', 'remotePort', 'localPort', 'label']);
            return { ...validate.forward(input), id: validate.id(id) };
          });
        }
        return saved;
      });
      return { hosts, windows };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { hosts: [], windows: [] };
      // Preserve a damaged file for repair; never silently replace it with empty settings.
      throw new Error('Remote settings could not be read. Repair remote-settings.json in the desktop application-data directory.', { cause: error });
    }
  }

  save(settings: RemoteSettings): Promise<void> {
    const body = JSON.stringify({ version: 1, ...settings });
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) return Promise.reject(new Error('Remote settings exceed their size limit'));
    if (this.pending) { this.pending.body = body; return this.pending.promise; }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.pending = { body, promise, resolve, reject };
    if (!this.writing) { this.writing = true; queueMicrotask(() => { void this.flush(); }); }
    return promise;
  }

  private async flush(): Promise<void> {
    // At most one active snapshot and one latest pending snapshot are retained,
    // even if several windows type faster than the filesystem can fsync.
    while (this.pending) {
      const job = this.pending; this.pending = undefined;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(job.body); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path); job.resolve();
      } catch (error) { job.reject(error); }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
    }
    this.writing = false;
  }
}
