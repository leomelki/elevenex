import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { getApiBaseUrl } from '@/shared/runtime/runtime-config';

export interface PreviewSessionDescriptor {
  previewId: string;
  urlPrefix: string;
}

/**
 * Preview sessions for the review workspace's rendered HTML.
 *
 * A session is a capability over one worktree, so every HTML tab in that
 * worktree shares one — which is why this memoises per worktree and coalesces
 * concurrent requests rather than opening a session per file. Reopening the
 * review panel, or toggling several tabs at once, must not fan out into a
 * burst of session creations.
 */
@Injectable({ providedIn: 'root' })
export class ReviewPreviewService {
  private readonly http = inject(HttpClient);
  private readonly sessions = new Map<
    string,
    { descriptor: PreviewSessionDescriptor; expires: number }
  >();
  private readonly inFlight = new Map<string, Promise<PreviewSessionDescriptor>>();

  async session(
    worktreePath: string,
    visualization = false,
    revalidate = false,
  ): Promise<PreviewSessionDescriptor> {
    const key = `${visualization ? 'visualization' : 'review'}:${worktreePath}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const cached = this.sessions.get(key);
    if (cached && !revalidate && cached.expires > Date.now()) {
      this.sessions.delete(key);
      this.sessions.set(key, cached);
      return cached.descriptor;
    }
    this.sessions.delete(key);

    const pending = firstValueFrom(
      this.http
        .post<PreviewSessionDescriptor>('/api/review-preview/sessions', {
          worktreePath,
          ...(visualization ? { visualization: true } : {}),
          // The browser-visible origin differs from Host behind the dev proxy
          // and in Electron; the backend validates it before building the CSP.
          previewOrigin: previewOrigin(),
        })
        .pipe(timeout(10_000)),
    )
      .then((descriptor) => {
        if (this.inFlight.get(key) === pending) {
          // Only settled descriptors count toward the bounded LRU cache. Never
          // evict in-flight coalescing when many directories open together.
          if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
          this.sessions.set(key, { descriptor, expires: Date.now() + 5 * 60 * 60 * 1000 });
        }
        return descriptor;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Absolute URL for one file inside a preview session. */
  async previewUrl(worktreePath: string, filePath: string, visualization = false): Promise<string> {
    return previewAssetUrl(await this.session(worktreePath, visualization), filePath);
  }

  async previewId(worktreePath: string): Promise<string> {
    return (await this.session(worktreePath)).previewId;
  }

  invalidateSession(worktreePath: string, visualization = false): void {
    const key = `${visualization ? 'visualization' : 'review'}:${worktreePath}`;
    this.sessions.delete(key);
    this.inFlight.delete(key);
  }

  async keepalive(previewIds: readonly string[]): Promise<readonly string[]> {
    const result = await firstValueFrom(
      this.http
        .post<{ expired: string[] }>('/api/review-preview/sessions/keepalive', {
          previewIds,
        })
        .pipe(timeout(10_000)),
    );
    return result.expired;
  }
}

/** Build asset URLs from a single descriptor so ID and URL cannot diverge. */
export function previewAssetUrl(session: PreviewSessionDescriptor, filePath: string): string {
  const encoded = filePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  // An index document's trailing slash is significant for sibling assets.
  const directorySuffix = encoded && filePath.endsWith('/') ? '/' : '';
  return `${absolute(session.urlPrefix)}${encoded}${directorySuffix}`;
}

/**
 * The origin the frame will be loaded from.
 *
 * `getApiBaseUrl()` is either absolute (Electron, where the page is file:// and
 * the backend is a loopback port) or the relative `/api` served by the dev
 * server, hence resolving against the document before taking the origin.
 */
function previewOrigin(): string | null {
  try {
    return new URL(getApiBaseUrl(), document.baseURI).origin;
  } catch {
    return null;
  }
}

/** The backend returns a prefix that is relative when it had no known origin. */
function absolute(urlPrefix: string): string {
  if (/^https?:\/\//i.test(urlPrefix)) return urlPrefix;
  return new URL(urlPrefix, document.baseURI).href;
}
