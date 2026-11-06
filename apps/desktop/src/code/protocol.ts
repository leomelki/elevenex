import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { CodeSurfaceState, CodeTarget } from '@elevenex/shared';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { CODE_OPERATIONS, object, reply, type CodeOperation, type WorkspaceDescriptor } from './validation';
import { codePolicy, CODE_EXTENSION_PATH, EXTENSION, workbenchDocument } from './document';
import { codeTransferCall } from './transfer-client';
import { CodeTransfers } from './transfers';
import type { TransferDialogs } from './transfer-contracts';

const MIME: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain' };
/** A private session-local HTTPS handler, not an Internet or loopback listener. */
export class CodeProtocol {
  readonly authority: string;
  private readonly lifetime = new AbortController();
  private closed = false;
  private ready = false;
  private readonly readyWaiters = new Set<(ready: boolean) => void>();
  private transportRevision = 0;
  private transfers?: CodeTransfers;
  private transferId?: string;
  dirty = 0;
  active = false;
  embedded = true;
  constructor(
    private readonly client: BackendClient,
    public windowId: number, public target: CodeTarget,
    public workspace: WorkspaceDescriptor, private readonly assets: string,
    private readonly fonts: string, private readonly dark: () => boolean,
    private readonly changed: (phase: CodeSurfaceState['phase'], message: string) => void,
    private readonly returnToChat: () => void = () => undefined,
    private readonly shellOrigin = 'app://elevenex',
    originIdentity = workspace.storageIdentity,
    private readonly presented: (filesOpen: boolean, hasEditors: boolean) => void = () => undefined,
    private readonly transferDialogs?: TransferDialogs,
  ) { this.authority = `w-${originIdentity.slice(0, 32)}.${originIdentity.slice(32)}.code.elevenex.invalid`; }
  allows(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === this.authority || /^[a-z0-9-]{1,80}$/.test(url.hostname.slice(0, -(this.authority.length + 1))) && url.hostname.endsWith('.' + this.authority));
    } catch { return false; }
  }
  bind(target: CodeTarget): boolean { const changed = target.scopeId !== this.target.scopeId || target.taskId !== this.target.taskId; if (changed) this.reset(); this.target = target; return changed; }
  reset(): void { this.transfers?.dispose(); this.transportRevision++; this.ready = false; }
  whenReady(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.closed || this.readyWaiters.size >= 32) return Promise.resolve(false);
    return new Promise(resolve => {
      const done = (ready: boolean) => { clearTimeout(timer); this.readyWaiters.delete(done); resolve(ready); };
      const timer = setTimeout(() => done(false), 30_000);
      this.readyWaiters.add(done);
    });
  }
  dispose(): void { this.closed = true; this.transfers?.dispose(); this.lifetime.abort(); for (const done of this.readyWaiters) done(false); }
  async handle(request: Request): Promise<Response> {
    if (this.closed || !this.allows(request.url)) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    // Keep the former path as a compatible alias for retained old documents.
    const pathname = url.pathname.startsWith(CODE_EXTENSION_PATH + '/') ? '/extension/' + url.pathname.slice(CODE_EXTENSION_PATH.length + 1) : url.pathname;
    const origin = request.headers.get('origin');
    if (origin && !this.allows(origin)) return new Response(null, { status: 403 });
    const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-site', 'Access-Control-Allow-Origin': origin ?? 'https://' + this.authority, 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (url.pathname.startsWith('/api/')) return this.api(request, url.pathname.slice(5), headers);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      if (url.pathname === '/') {
        if (url.host !== this.authority) return new Response(null, { status: 403 });
        const tokens = await readFile(join(__dirname, 'tokens.css'), 'utf8');
        const document = workbenchDocument(this.workspace, this.authority, tokens, this.dark(), this.shellOrigin);
        return new Response(document.html, { headers: { ...headers, 'Content-Type': 'text/html', 'Content-Security-Policy': document.policy } });
      }
      if (pathname === '/extension/package.nls.json') return Response.json({}, { headers });
      if (pathname === '/extension/package.json') return Response.json(EXTENSION, { headers });
      const path = decodeURIComponent(pathname);
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.')) return new Response(null, { status: 403 });
      let root: string, relativePath: string;
      if (path.startsWith('/extension/')) { root = join(__dirname, 'web'); relativePath = path.slice('/extension/'.length); }
      else if (path.startsWith('/fonts/')) { root = this.fonts; relativePath = path.slice('/fonts/'.length); }
      else if (path === '/LICENSE.txt') { root = __dirname; relativePath = 'LICENSE.txt'; }
      else { root = this.assets; relativePath = path.replace(/^\/(?:assets\/)?/, ''); }
      const actual = await realpath(join(root, relativePath)), child = relative(await realpath(root), actual);
      if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child) || !(await stat(actual)).isFile()) return new Response(null, { status: 403 });
      const extensionWorker = url.hostname !== this.authority;
      headers['Content-Type'] = MIME[extname(actual)] ?? 'application/octet-stream';
      if (extname(actual) === '.html') {
        if (!extensionWorker || !actual.endsWith('webWorkerExtensionHostIframe.html')) return new Response(null, { status: 403 });
        const html = await readFile(actual, 'utf8');
        const hashes = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => createHash('sha256').update(match[1] ?? '').digest('base64'));
        headers['Content-Security-Policy'] = codePolicy(this.authority, 'static', true, hashes, this.shellOrigin);
        return new Response(html, { headers });
      }
      headers['Content-Security-Policy'] = codePolicy(this.authority, 'static', extensionWorker);
      headers['Cache-Control'] = path.startsWith('/extension/') ? 'no-store' : 'private, max-age=31536000, immutable';
      return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(actual)) as ReadableStream<Uint8Array>, { headers });
    } catch { return new Response(null, { status: 404, headers }); }
  }
  private async api(request: Request, operation: string, headers: Record<string, string>): Promise<Response> {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return new Response(null, { status: 405 });
    let size = 0; const chunks: Uint8Array[] = [];
    if (!request.body) return new Response(null, { status: 400 });
    const reader = request.body.getReader();
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 12 * 1024 * 1024) return new Response(null, { status: 413 }); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let input: Record<string, unknown>;
    try { input = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return new Response(null, { status: 400 }); }
    if (['transfer-start', 'transfer-status', 'transfer-cancel'].includes(operation)) {
      if (!this.ready || input['generation'] !== this.workspace.identity || input['transportRevision'] !== this.transportRevision) return Response.json({ error: 'workspace-changed' }, { status: 409, headers });
      try {
        if (operation === 'transfer-start') {
          if (!this.active || !this.transferDialogs || this.client.state(this.windowId).scope?.id !== this.target.scopeId) return new Response(null, { status: 403, headers });
          if (this.transfers && this.transferId && this.transfers.status(this.transferId).phase === 'running') throw new Error('A transfer is already running.');
          const { scopeId, taskId } = this.target, windowId = this.windowId, generation = this.workspace.identity, revision = this.transportRevision;
          this.transfers = new CodeTransfers(this.transferDialogs, codeTransferCall(this.client, { windowId, scopeId, taskId, generation }, () => !this.closed && this.windowId === windowId && this.transportRevision === revision && this.workspace.identity === generation, this.lifetime.signal));
          const started = this.transfers.start(input); this.transferId = started.id;
          return Response.json(started, { headers });
        }
        if (!this.transfers) throw new Error('No transfer.');
        return Response.json(this.transfers.status(input['id'], operation === 'transfer-cancel'), { headers });
      } catch { return Response.json({ error: 'Transfer is unavailable or already running.' }, { status: 400, headers }); }
    }
    if (operation === 'presentation') {
      if (Object.keys(input).some(key => !['generation','transportRevision','filesOpen','hasEditors'].includes(key)) || typeof input['filesOpen'] !== 'boolean' || typeof input['hasEditors'] !== 'boolean') return new Response(null,{status:400,headers});
      const accepted = this.ready && input['generation'] === this.workspace.identity && input['transportRevision'] === this.transportRevision;
      if (accepted) this.presented(input['filesOpen'], input['hasEditors']);
      return Response.json({accepted},{headers});
    }
    if (operation === 'return-to-chat') {
      // This local view intent never calls the backend or replays a mutation.
      // A hidden/standalone workbench cannot dismiss another window's panel.
      const accepted = this.active && this.embedded && input['generation'] === this.workspace.identity && input['transportRevision'] === this.transportRevision;
      if (accepted) this.returnToChat();
      return Response.json({ accepted }, { headers });
    }
    if (operation === 'changes' && !this.active && this.ready) return Response.json({ sequence: input['after'] ?? 0, reset: false, paths: [], paused: true }, { headers });
    if (operation === 'ready') {
      if (input['transportRevision'] !== this.transportRevision) return Response.json({ error: 'stale-lease' }, { status: 409, headers });
      this.ready = true; for (const done of this.readyWaiters) done(true);
      if (typeof input['dirty'] === 'number' && Number.isSafeInteger(input['dirty']) && input['dirty'] >= 0 && input['dirty'] <= 1000) this.dirty = input['dirty'];
      this.changed('ready', 'Task connected'); return Response.json({ accepted: true, generation: this.workspace.identity, transportRevision: this.transportRevision, embedded: this.embedded }, { headers });
    }
    if (!(CODE_OPERATIONS as readonly string[]).includes(operation)) return new Response(null, { status: 404 });
    const op = operation as CodeOperation, scopeId = this.target.scopeId, generation = this.workspace.identity, transportRevision = this.transportRevision;
    const reset = input['generation'] !== generation;
    const mutation = ['write', 'mkdir', 'rename', 'delete'].includes(op);
    if (mutation && (reset || input['transportRevision'] !== transportRevision)) return Response.json({ error: 'workspace-changed' }, { status: 409, headers });
    const result = await this.client.execute(this.windowId, scopeId, mutation || ['filenames', 'search', 'search-page'].includes(op) ? null : `code:${this.workspace.identity}:${op}:${JSON.stringify(input)}`, mutation, async (endpoint, signal) => {
      const value = await requestBackendJson(endpoint, { path: `/api/code-workspaces/${this.target.taskId}/${op}`, method: 'POST', body: { ...input, identity: generation, ...(op === 'changes' && reset ? { after: 0 } : {}) }, limit: op === 'read' ? 12 * 1024 * 1024 : 256 * 1024, conflictMessages: { 'file-conflict': 'File changed on disk.', 'file-changing': 'File is changing.', 'target-exists': 'Destination already exists.', 'workspace-changed': 'Task workspace changed.', 'workspace-unavailable': 'Task workspace is unavailable.' } }, signal);
      return reply(op, value);
    }, 30_000, ['filenames', 'search', 'search-page'].includes(op) ? AbortSignal.any([this.lifetime.signal, request.signal]) : this.lifetime.signal);
    if (this.workspace.identity !== generation || this.transportRevision !== transportRevision) return Response.json({ error: 'workspace-changed' }, { status: 409, headers });
    if (!result.ok) {
      if (result.error.status === 409 && ['Task workspace changed.', 'Task workspace is unavailable.'].includes(result.error.message)) this.changed('disconnected', 'Workspace changed · saves blocked');
      if (result.error.status !== 404 && result.error.status !== 400 && result.error.status !== 403 && result.error.status !== 409) this.changed('disconnected', result.error.code === 'outcome-unknown' ? 'Save unconfirmed · edits retained' : 'Disconnected · edits retained');
      return Response.json({ error: result.error.status === 409 ? result.error.message === 'File changed on disk.' ? 'file-conflict' : result.error.message === 'File is changing.' ? 'file-changing' : result.error.message === 'Destination already exists.' ? 'target-exists' : 'workspace-changed' : result.error.code }, { status: result.error.status ?? (result.error.code === 'stale-scope' ? 409 : 503), headers });
    }
    if (op === 'changes') { const metadata = object(result.value); if (typeof metadata['taskName'] === 'string' && typeof metadata['branch'] === 'string') this.workspace = { ...this.workspace, name: metadata['taskName'], branch: metadata['branch'] }; }
    return Response.json({ ...object(result.value), generation, transportRevision, dark: this.dark(), embedded: this.embedded, ...(op === 'changes' && reset ? { reset: true, paths: ['/'] } : {}) }, { headers });
  }
}
