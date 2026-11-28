import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { AtomicJsonFile } from '../atomic-json-file';
import * as validate from './validation';

export interface TerminalForwardService {
  readonly hostId: string;
  readonly targetHost: string;
  readonly remotePort: number;
}
export interface TerminalForwardAssignment extends TerminalForwardService { readonly localPort: number }
export interface TerminalForwardDefinition extends TerminalForwardService { readonly forwardId: string }
export interface TerminalForwardSettings {
  readonly assignments: readonly TerminalForwardAssignment[];
  readonly definitions: readonly TerminalForwardDefinition[];
}

export function terminalForwardKey(service: TerminalForwardService): string {
  return JSON.stringify([service.hostId, service.targetHost, service.remotePort]);
}

export function terminalForwardTarget(host: string): void {
  if (host !== '::1' && !(isIP(host) === 4 && host.startsWith('127.'))) throw new Error('Invalid forward loopback address');
}

function service(raw: Record<string, unknown>): TerminalForwardService {
  const targetHost = raw['targetHost'];
  if (typeof targetHost !== 'string') throw new Error('Invalid terminal forward target');
  terminalForwardTarget(targetHost);
  return { hostId: validate.id(raw['hostId']), targetHost, remotePort: validate.port(raw['remotePort']) };
}

/** Sidecar keeps the version-1 remote settings readable by older desktop releases. */
export class TerminalForwardStore {
  private readonly writer: AtomicJsonFile;
  constructor(private readonly path: string) { this.writer = new AtomicJsonFile(path, 16 * 1024 * 1024, true); }

  async load(): Promise<TerminalForwardSettings> {
    try {
      if ((await stat(this.path)).size > 16 * 1024 * 1024) throw new Error('Terminal forwards exceed their size limit');
      const raw = validate.object(JSON.parse(await readFile(this.path, 'utf8')), ['version', 'assignments', 'definitions']);
      if (raw['version'] !== 1 || !Array.isArray(raw['assignments']) || raw['assignments'].length > 10000 ||
          !Array.isArray(raw['definitions']) || raw['definitions'].length > 32768) throw new Error('Invalid terminal forwards');
      const assignments = raw['assignments'].map((value: unknown): TerminalForwardAssignment => {
        const row = validate.object(value, ['hostId', 'targetHost', 'remotePort', 'localPort']);
        const localPort = validate.port(row['localPort']);
        if (localPort < 20000 || localPort > 29999) throw new Error('Invalid assigned terminal port');
        return { ...service(row), localPort };
      });
      const definitions = raw['definitions'].map((value: unknown): TerminalForwardDefinition => {
        const row = validate.object(value, ['hostId', 'targetHost', 'remotePort', 'forwardId']);
        return { ...service(row), forwardId: validate.id(row['forwardId']) };
      });
      if (new Set(assignments.map(terminalForwardKey)).size !== assignments.length ||
          new Set(assignments.map(row => row.localPort)).size !== assignments.length ||
          new Set(definitions.map(row => row.forwardId)).size !== definitions.length) throw new Error('Duplicate terminal forwards');
      return { assignments, definitions };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { assignments: [], definitions: [] };
      // Losing this file would silently change established URLs and socket families.
      throw new Error('Terminal forwards could not be read. Repair the desktop terminal-forwards file before reconnecting.', { cause: error });
    }
  }

  save(settings: TerminalForwardSettings): Promise<void> {
    return this.writer.write(JSON.stringify({ version: 1, ...settings }));
  }
}
