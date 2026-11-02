import { readFile, stat } from 'node:fs/promises';
import { AtomicJsonFile } from '../atomic-json-file';
import type { EnvironmentContext, EnvironmentSelection, RemoteForwardInput, RemoteHost } from '@elevenex/shared';
import type { WaitingWriting } from '@elevenex/shared';
import * as validate from './validation';

export interface SavedWindow {
  selection: EnvironmentSelection;
  contexts: Record<string, EnvironmentContext>;
  /** Intentional disconnect remains disconnected after relaunch. */
  connect: boolean;
  waiting?: Record<string, WaitingWriting>;
  forwards: Record<string, (RemoteForwardInput & { id: string })[]>;
}
export interface RemoteSettings { hosts: RemoteHost[]; windows: SavedWindow[] }
export const emptyContext = (): EnvironmentContext => ({ projectId: null, taskId: null, sessionId: null, draft: '', cursor: null });
export const emptyWindow = (): SavedWindow => ({ selection: { kind: 'local' }, contexts: {}, connect: false, forwards: {} });
export const environmentKey = (value: EnvironmentSelection): string => value.kind === 'local' ? 'local' : value.hostId;

/** One application owner serializes atomic writes. Never stores challenge replies. */
export class RemoteSettingsStore {
  private readonly writer: AtomicJsonFile;
  constructor(private readonly path: string) { this.writer = new AtomicJsonFile(path, 16 * 1024 * 1024); }

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
    const windows = settings.windows.map(window => ({ selection: window.selection, contexts: window.contexts, connect: window.connect, forwards: window.forwards }));
    return this.writer.write(JSON.stringify({ version: 1, hosts: settings.hosts, windows }));
  }
}
