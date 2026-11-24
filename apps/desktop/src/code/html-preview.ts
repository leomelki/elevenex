import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { fileReadReply } from './validation';
import { STATIC_PREVIEW_POLICY } from './webview';

const HTML = 'text/html';
const mimeTypes = new Map([
  ['.html', HTML], ['.htm', HTML], ['.css', 'text/css'],
  ['.avif', 'image/avif'], ['.gif', 'image/gif'], ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'],
  ['.otf', 'font/otf'], ['.ttf', 'font/ttf'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

interface PreviewScope {
  readonly windowId: number;
  readonly scopeId: string;
  readonly taskId: number;
  readonly generation: string;
  current(): boolean;
}

interface PreviewLease {
  readonly url: URL;
  readonly scope: PreviewScope;
  readonly controller: AbortController;
  initial?: { path: string; bytes: Buffer<ArrayBuffer> };
}

export function isHtmlPreviewOrigin(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    /^elevenex-preview-[a-f0-9]{32}\.invalid$/.test(url.hostname);
}

function previewFile(path: unknown): { path: string; mime: string } | undefined {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') ||
      path.includes('\\') || Array.from(path).some(character => character.charCodeAt(0) < 32)) return;
  // Neither private dotfiles nor the editor's transient saves are web assets.
  if (path.slice(1).split('/').some(part => !part || part.startsWith('.'))) return;
  const mime = mimeTypes.get(posix.extname(path).toLowerCase());
  return mime ? { path, mime } : undefined;
}

function resource(url: URL): ReturnType<typeof previewFile> {
  try { return previewFile(decodeURIComponent(url.pathname)); }
  catch { return undefined; }
}

/** One private, read-only static site per workbench. A fresh registrable
 * domain isolates the page from shell/editor cookies, storage and APIs. */
export class HtmlPreview {
  private lease?: PreviewLease;
  private pending?: AbortController;
  constructor(private readonly client: BackendClient, private readonly authority: string, private readonly shellOrigin: string) {}

  owns(url: URL): boolean { return isHtmlPreviewOrigin(url) && url.origin === this.lease?.url.origin; }
  current(url: URL): boolean { return this.owns(url) && this.lease?.scope.current() === true; }
  allowsDocument(url: URL): boolean { return this.current(url) && resource(url)?.mime === HTML; }

  async open(path: unknown, scope: PreviewScope, request: Request, headers: HeadersInit): Promise<Response> {
    const file = previewFile(path);
    if (file?.mime !== HTML) return Response.json({ error: 'invalid-preview-file' }, { status: 400, headers });
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const url = new URL(file.path.split('/').map(encodeURIComponent).join('/'), `https://elevenex-preview-${randomBytes(16).toString('hex')}.invalid`);
    try {
      const result = await this.read(scope, url.origin, file.path, signal);
      if (signal.aborted || !scope.current()) return Response.json({ error: 'workspace-changed' }, { status: 409, headers });
      if (!result.ok) return Response.json({ error: 'preview-file-unavailable' }, { status: result.error.status ?? 503, headers });
      this.lease?.controller.abort();
      this.lease = { url, scope, controller, initial: { path: file.path, bytes: result.value } };
      return Response.json({ url: url.href }, { headers });
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  close(origin: unknown): void {
    if (origin !== this.lease?.url.origin) return;
    this.lease?.controller.abort();
    this.lease = undefined;
  }

  reset(): void {
    this.pending?.abort();
    this.close(this.lease?.url.origin);
  }

  async handle(request: Request, url: URL): Promise<Response> {
    const lease = this.lease;
    if (!lease || !this.current(url)) return new Response(null, { status: 403 });
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const file = resource(url);
    if (!file) return new Response(null, { status: 404 });
    let bytes: Buffer<ArrayBuffer>;
    if (lease.initial?.path === file.path) {
      bytes = lease.initial.bytes;
      lease.initial = undefined;
    } else {
      const result = await this.read(lease.scope, url.origin, file.path, lease.controller.signal);
      if (!this.current(url) || request.signal.aborted) return new Response(null, { status: 403 });
      if (!result.ok) return new Response(null, { status: result.error.status ?? 503 });
      bytes = result.value;
    }
    const csp = [
      STATIC_PREVIEW_POLICY, "frame-src 'none'", "img-src 'self' data:",
      "font-src 'self' data:", "media-src 'self'", "base-uri 'self'",
      "sandbox allow-same-origin",
      `frame-ancestors https://*.preview.${this.authority} https://${this.authority} ${this.shellOrigin}`,
    ];
    return new Response(bytes, { headers: {
      'Content-Type': file.mime, 'Content-Security-Policy': csp.join('; '),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer',
    } });
  }

  private read(scope: PreviewScope, origin: string, path: string, ownerSignal: AbortSignal) {
    return this.client.execute(scope.windowId, scope.scopeId, `html-preview:${origin}:${path}`, false, async (endpoint, signal) => {
      const result = await requestBackendJson(endpoint, {
        path: `/api/code-workspaces/${scope.taskId}/read`, method: 'POST',
        body: { identity: scope.generation, path }, limit: 12 * 1024 * 1024,
      }, signal);
      return Buffer.from(fileReadReply(result).content, 'base64');
    }, 10_000, ownerSignal);
  }
}
