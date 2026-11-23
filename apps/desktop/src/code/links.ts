import { randomUUID } from 'node:crypto';
import type { BackendClient } from '../backend-client/client';
import { invalidResponse, requestBackendJson } from '../backend-client/transport';
import { object, reply, string } from './validation';

interface LinkLease {
  readonly windowId: number;
  readonly scopeId: string;
  readonly taskId: number;
  readonly generation: string;
}
interface ExternalGrant {
  readonly path: string;
  readonly fingerprint: string;
  readonly type: 1 | 2;
}
type FileOperation = 'stat' | 'read' | 'directory';
type ResolvedLink = (ExternalGrant & { readonly kind: 'external'; readonly name: string } |
  { readonly kind: 'workspace'; readonly path: string; readonly type: 1 | 2 }) &
  { readonly line: number; readonly column: number };
const isPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000_000;

/** Outside paths stay in main. The workbench receives opaque, read-only grants
 * for exactly the file or folder selected through the shell. */
export class CodeLinks {
  private readonly grants = new Map<string, ExternalGrant>();
  constructor(private readonly client: BackendClient, private readonly signal: AbortSignal) {}
  clear(): void { this.grants.clear(); }
  resolve(lease: LinkLease, path: string) {
    return this.client.execute(lease.windowId, lease.scopeId, null, false, async (endpoint, signal): Promise<ResolvedLink> => {
      const raw = object(await requestBackendJson(endpoint, {
        path: '/api/code-workspaces/' + lease.taskId + '/link-resolve', method: 'POST',
        body: { identity: lease.generation, path }, limit: 32 * 1024,
      }, signal));
      const resolved = string(raw['path']), line = raw['line'], column = raw['column'], type = raw['type'];
      if ((type !== 1 && type !== 2) || !isPosition(line) || !isPosition(column)) throw invalidResponse();
      if (raw['kind'] === 'workspace' && /^\/(?!\/)/.test(resolved) && !resolved.split('/').some(p => p === '.' || p === '..' || p.toLowerCase() === '.git'))
        return { kind: 'workspace', path: resolved, type, line, column };
      const name = string(raw['name']), fingerprint = string(raw['fingerprint'], 64);
      if (raw['kind'] !== 'external' || !name || name.includes('/') || name === '.' || name === '..' ||
          !/^(\/|[a-z]:[\\/])/i.test(resolved) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw invalidResponse();
      return { kind: 'external', path: resolved, name, fingerprint, type, line, column };
    }, 30_000, this.signal);
  }
  grant(resource: ExternalGrant): string {
    for (const [id, existing] of this.grants) {
      if (existing.path === resource.path && existing.fingerprint === resource.fingerprint) {
        this.grants.delete(id); this.grants.set(id, existing); return id;
      }
    }
    const id = randomUUID();
    if (this.grants.size >= 32) {
      const oldest = this.grants.keys().next().value;
      if (oldest) this.grants.delete(oldest);
    }
    this.grants.set(id, resource);
    return id;
  }
  async read(lease: LinkLease, operation: FileOperation, input: Record<string, unknown>, request: Request, headers: Record<string, string>, current: () => boolean): Promise<Response> {
    const id = input['id'];
    const grant = typeof id === 'string' ? this.grants.get(id) : undefined;
    const path = input['path'], after = input['after'];
    if (typeof id !== 'string' || !grant || typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') ||
        grant.type === 1 && path !== '/' || after !== undefined && (typeof after !== 'string' || after.length > 4096))
      return new Response(null, { status: 404, headers });
    const result = await this.client.execute(lease.windowId, lease.scopeId, null, false, async (endpoint, signal) => {
      return reply(operation, await requestBackendJson(endpoint, {
        path: '/api/code-workspaces/' + lease.taskId + '/link-' + operation, method: 'POST',
        body: { identity: lease.generation, root: grant.path, fingerprint: grant.fingerprint, path, after },
        limit: operation === 'read' ? 12 * 1024 * 1024 : 256 * 1024,
      }, signal));
    }, 30_000, AbortSignal.any([this.signal, request.signal]));
    if (!current() || this.grants.get(id) !== grant) return new Response(null, { status: 409, headers });
    return result.ok ? Response.json(result.value, { headers })
      : Response.json({ error: result.error.code }, { status: result.error.status ?? 503, headers });
  }
}
