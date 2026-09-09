import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import * as path from 'node:path';
import { detectMimeType, isWithinWorktree } from '../files/files.service.js';
import { transformPreviewHtml } from './html-instrumentation.js';
import type { PreviewSessionDescriptor } from './review-preview.types.js';

/**
 * Serving a worktree's HTML files, and their dependencies, into a review
 * preview frame.
 *
 * The unit is a session over a whole worktree rather than over one file. That
 * single choice is what makes dependency loading work without any URL
 * rewriting: the preview path mirrors the worktree layout, so `./style.css`,
 * `../shared/app.js` and a link to a sibling page all resolve by ordinary URL
 * resolution, and a link to another page is already a valid preview URL.
 *
 * Isolation is not incidental here. The frame runs arbitrary JavaScript out of
 * the repository under review, and the API it sits next to has no auth and
 * `Access-Control-Allow-Origin: *` — so a page could otherwise read or write
 * any file on disk in two lines. `sandbox` (applied by the embedder and
 * repeated in the CSP) plus a `connect-src` confined to this one prefix is
 * what reduces that to "can read the worktree it came from". It is not a
 * perfect jail — see `buildContentSecurityPolicy` — but it is strictly better
 * than opening the same file in a normal browser tab.
 */

interface PreviewSession {
  previewId: string;
  /** Symlink-resolved worktree root. Every request is confined to this. */
  root: string;
  /** Browser-visible origin, used to build the CSP prefix. */
  previewOrigin: string | null;
  createdAt: number;
  lastAccessAt: number;
}

/** A `*path` wildcard: Express 5 gives an array of segments, older forms a string. */
export type PreviewAssetPath = string | string[] | undefined;

export interface PreviewAsset {
  body: Buffer | Readable;
  mimeType: string;
  /** Set for the entry document; null for plain assets. */
  contentSecurityPolicy: string | null;
  instrumented: boolean;
}

/** Reserved first path segment for bridge assets. */
export const PREVIEW_INTERNAL_SEGMENT = '___ex';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
/** Read into memory below this; stream above it. */
const STREAM_THRESHOLD_BYTES = 1_000_000;
/** Refuse outright above this — nothing in a review needs it. */
const MAX_ASSET_BYTES = 100_000_000;

const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?$/;

@Injectable()
export class ReviewPreviewService {
  private readonly logger = new Logger('ReviewPreview');
  private readonly sessions = new Map<string, PreviewSession>();
  /** root -> previewId, so reopening a worktree reuses its session. */
  private readonly sessionsByRoot = new Map<string, string>();

  async createSession(
    worktreePath: string,
    previewOrigin: string | null,
  ): Promise<PreviewSessionDescriptor> {
    if (!worktreePath) {
      throw new BadRequestException('worktreePath is required');
    }

    this.sweep();

    let root: string;
    try {
      root = await fs.realpath(worktreePath);
    } catch {
      throw new BadRequestException(`Worktree does not exist: ${worktreePath}`);
    }

    const stats = await fs.stat(root);
    if (!stats.isDirectory()) {
      throw new BadRequestException(`Not a directory: ${worktreePath}`);
    }

    const existingId = this.sessionsByRoot.get(root);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      existing.lastAccessAt = Date.now();
      // A reopened session can come from a different origin (dev server vs
      // packaged app), and a stale origin would block every asset.
      existing.previewOrigin = normalizeOrigin(previewOrigin) ?? existing.previewOrigin;
      return this.describe(existing);
    }

    if (this.sessions.size >= MAX_SESSIONS) this.evictOldest();

    const session: PreviewSession = {
      previewId: randomBytes(16).toString('hex'),
      root,
      previewOrigin: normalizeOrigin(previewOrigin),
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
    };
    this.sessions.set(session.previewId, session);
    this.sessionsByRoot.set(root, session.previewId);

    this.logger.debug(
      `Preview session ${session.previewId} for ${root} (origin: ${session.previewOrigin ?? 'unknown'})`,
    );
    return this.describe(session);
  }

  /** Throws NotFound for an unknown or expired id. */
  requireSession(previewId: string): PreviewSession {
    const session = this.sessions.get(previewId);
    if (!session || Date.now() - session.lastAccessAt > SESSION_TTL_MS) {
      if (session) this.drop(session);
      throw new NotFoundException('Preview session not found');
    }
    session.lastAccessAt = Date.now();
    return session;
  }

  /**
   * Resolve, read and (for HTML) instrument one file inside a preview session.
   */
  async readAsset(previewId: string, relativePath: PreviewAssetPath): Promise<PreviewAsset> {
    const session = this.requireSession(previewId);
    const absolutePath = await this.resolveWithinSession(session, relativePath);

    const stats = await fs.stat(absolutePath);
    if (stats.size > MAX_ASSET_BYTES) {
      throw new PayloadTooLargeException('File is too large to preview');
    }

    const mimeType = detectMimeType(absolutePath);
    const isHtml = mimeType.startsWith('text/html');

    if (isHtml) {
      const source = await fs.readFile(absolutePath, 'utf-8');
      const previewPrefix = this.prefixFor(session);
      const filePath = path
        .relative(session.root, absolutePath)
        .split(path.sep)
        .join('/');
      const { html, instrumented } = transformPreviewHtml({
        source,
        previewPrefix,
        filePath,
        previewId: session.previewId,
        bridgeUrl: `${previewPrefix}${PREVIEW_INTERNAL_SEGMENT}/bridge.js`,
      });
      return {
        body: Buffer.from(html, 'utf-8'),
        mimeType,
        contentSecurityPolicy: this.buildContentSecurityPolicy(session),
        instrumented,
      };
    }

    const body =
      stats.size > STREAM_THRESHOLD_BYTES
        ? createReadStream(absolutePath)
        : await fs.readFile(absolutePath);

    return { body, mimeType, contentSecurityPolicy: null, instrumented: false };
  }

  /**
   * Map a request path onto a real file inside the session root.
   *
   * Two containment checks, not one. `isWithinWorktree` is lexical, and here
   * the requested paths come from untrusted page content — so a symlink
   * committed in the repo and pointing at, say, `~/.ssh` would pass the
   * lexical check and still escape. Resolving the real path and re-checking
   * closes that. This is deliberately local to previews: making
   * `FilesService` resolve symlinks globally is a larger, riskier change.
   */
  private async resolveWithinSession(
    session: PreviewSession,
    relativePath: PreviewAssetPath,
  ): Promise<string> {
    // Express 5 hands a `*path` wildcard back as an array of already-decoded
    // segments, not a string — so a nested asset arrives as ['assets','a.css'].
    // Decoding again here would be wrong twice over: it would mangle a
    // filename that legitimately contains a percent sign, and it would let a
    // doubly-encoded '..' through as a real one.
    const raw = Array.isArray(relativePath)
      ? relativePath
      : String(relativePath ?? '').split('/');
    const segments = raw.filter((segment) => segment.length > 0);

    for (const segment of segments) {
      if (segment === '.git' || segment.includes('\0')) {
        throw new NotFoundException('Not found');
      }
    }
    if (segments[0] === PREVIEW_INTERNAL_SEGMENT) {
      throw new NotFoundException('Not found');
    }

    const candidate = path.resolve(session.root, segments.join(path.sep));
    if (!isWithinWorktree(session.root, candidate)) {
      throw new NotFoundException('Not found');
    }

    let stats;
    try {
      stats = await fs.stat(candidate);
    } catch {
      throw new NotFoundException('Not found');
    }

    const target = stats.isDirectory() ? path.join(candidate, 'index.html') : candidate;

    let real: string;
    try {
      real = await fs.realpath(target);
    } catch {
      throw new NotFoundException('Not found');
    }
    if (!isWithinWorktree(session.root, real)) {
      throw new NotFoundException('Not found');
    }

    return real;
  }

  /**
   * The policy applied to a preview document.
   *
   * `connect-src` is the point of the whole exercise: it is what stops a
   * reviewed page from calling the unauthenticated file API. The looser parts
   * are load-bearing too — `'unsafe-inline'` because repo pages routinely have
   * inline scripts and style attributes, `'unsafe-eval'` because bundlers and
   * template libraries use `new Function` and denying it buys nothing while
   * inline is already allowed.
   *
   * `frame-ancestors` is deliberately absent. It protects nothing the preview
   * id does not already, and the legitimate embedders differ across three
   * runtime modes (file: in packaged Electron, the dev server, the backend
   * origin), so a guess here would break Electron for no gain.
   *
   * Known gap: CSP has no shipped `navigate-to`, and a sandbox without
   * `allow-top-navigation` still lets the frame navigate *itself*. A page can
   * therefore still exfiltrate by setting `location.href`. No header closes
   * that; the embedder watches for it instead.
   */
  private buildContentSecurityPolicy(session: PreviewSession): string {
    const p = session.previewOrigin ? this.prefixFor(session) : null;
    // With no known origin we cannot name our own path prefix. Fall back to
    // 'self' for fetching subresources — the page can then load API paths as
    // scripts or images, which leaks nothing on its own — but hold connect-src
    // at 'none', since that is the directive that would let it read a response
    // and send it somewhere. Failing closed on the one that matters beats
    // serving a blank preview.
    const src = p ?? "'self'";

    return [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `script-src ${src} 'unsafe-inline' 'unsafe-eval'`,
      `style-src ${src} 'unsafe-inline'`,
      `img-src ${src} data: blob:`,
      `font-src ${src} data:`,
      `media-src ${src} blob:`,
      `connect-src ${p ?? "'none'"}`,
      `frame-src ${src}`,
      `child-src ${src}`,
      `worker-src ${src} blob:`,
      `manifest-src ${src}`,
      'sandbox allow-scripts',
    ].join('; ');
  }

  /**
   * Absolute URL prefix for a session, with a trailing slash.
   *
   * The trailing slash matters: CSP host-source path matching is only a prefix
   * match when the path ends in one, otherwise it is an exact match and every
   * asset is blocked.
   */
  private prefixFor(session: PreviewSession): string {
    const origin = session.previewOrigin ?? '';
    return `${origin}/api/review-preview/p/${session.previewId}/`;
  }

  private describe(session: PreviewSession): PreviewSessionDescriptor {
    return { previewId: session.previewId, urlPrefix: this.prefixFor(session) };
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastAccessAt > SESSION_TTL_MS) this.drop(session);
    }
  }

  private evictOldest(): void {
    let oldest: PreviewSession | null = null;
    for (const session of this.sessions.values()) {
      if (!oldest || session.lastAccessAt < oldest.lastAccessAt) oldest = session;
    }
    if (oldest) this.drop(oldest);
  }

  private drop(session: PreviewSession): void {
    this.sessions.delete(session.previewId);
    if (this.sessionsByRoot.get(session.root) === session.previewId) {
      this.sessionsByRoot.delete(session.root);
    }
  }
}

/**
 * The browser-visible origin cannot be derived server-side: the dev server
 * proxies with `changeOrigin`, so `Host` is the backend's own and no
 * `x-forwarded-host` is set. The client declares it instead, which is not an
 * escalation — a caller who controls the client already has everything the
 * client has — but it is still validated rather than interpolated blind.
 */
function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/$/, '');
  return ORIGIN_PATTERN.test(trimmed) ? trimmed : null;
}
