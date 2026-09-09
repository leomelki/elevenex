import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getApiBaseUrl } from '@/shared/runtime/runtime-config';

interface PreviewSessionDescriptor {
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
  private readonly sessions = new Map<string, Promise<PreviewSessionDescriptor>>();

  async session(worktreePath: string): Promise<PreviewSessionDescriptor> {
    const existing = this.sessions.get(worktreePath);
    if (existing) return existing;

    const pending = firstValueFrom(
      this.http.post<PreviewSessionDescriptor>('/api/review-preview/sessions', {
        worktreePath,
        // The backend cannot infer this: the dev server proxies with
        // changeOrigin, so its Host header is the backend's own, and in
        // packaged Electron the page origin is file:// entirely. It needs the
        // browser-visible origin to build a CSP that names the preview's own
        // path prefix.
        previewOrigin: previewOrigin(),
      }),
    ).catch((error: unknown) => {
      // Don't cache a failure: the next attempt should retry, not replay it.
      this.sessions.delete(worktreePath);
      throw error;
    });

    this.sessions.set(worktreePath, pending);
    return pending;
  }

  /** Absolute URL for one file inside a preview session. */
  async previewUrl(worktreePath: string, filePath: string): Promise<string> {
    const { urlPrefix } = await this.session(worktreePath);
    const encoded = filePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${absolute(urlPrefix)}${encoded}`;
  }

  async previewId(worktreePath: string): Promise<string> {
    return (await this.session(worktreePath)).previewId;
  }
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
