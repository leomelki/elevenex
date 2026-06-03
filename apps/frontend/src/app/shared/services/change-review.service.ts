import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { finalize, Observable, shareReplay, tap } from 'rxjs';
import {
  ChangeReviewContextWindow,
  ChangeReviewFileFingerprintsResponse,
  ChangeReviewFileWindow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from '@/shared/models/change-review.model';

@Injectable({ providedIn: 'root' })
export class ChangeReviewService {
  private readonly http = inject(HttpClient);
  private readonly summaryCache = new Map<string, Observable<ChangeReviewSummary>>();
  private readonly fileWindowCache = new Map<string, Observable<ChangeReviewFileWindow>>();
  private readonly contextWindowCache = new Map<string, Observable<ChangeReviewContextWindow>>();

  getSummary(
    worktreePath: string,
    scope: ChangeReviewScope,
    refreshBase = false,
    forceLoad = false,
  ) {
    if (refreshBase) {
      this.clearCache(worktreePath, scope);
    }
    const key = this.summaryKey(worktreePath, scope, forceLoad);
    const cached = this.summaryCache.get(key);
    if (cached) return cached;

    let emitted = false;
    let request!: Observable<ChangeReviewSummary>;
    request = this.http
      .get<ChangeReviewSummary>('/api/git/change-review/summary', {
        params: {
          worktreePath,
          scope,
          refreshBase: String(refreshBase),
          forceLoad: String(forceLoad),
        },
      })
      .pipe(
        tap({
          next: () => {
            emitted = true;
          },
        }),
        finalize(() => this.dropUnresolved(this.summaryCache, key, request, emitted)),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
    this.summaryCache.set(key, request);
    return request;
  }

  getFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: {
      offset?: number;
      limit?: number;
      context?: number;
      forceFileLoad?: boolean;
    } = {},
    forceLoad = false,
  ) {
    const normalized = {
      offset: options.offset ?? 0,
      limit: options.limit ?? 600,
      context: options.context ?? 8,
      forceFileLoad: Boolean(options.forceFileLoad),
    };
    const key = this.fileWindowKey(worktreePath, scope, path, normalized, forceLoad);
    const cached = this.fileWindowCache.get(key);
    if (cached) return cached;

    let emitted = false;
    let request!: Observable<ChangeReviewFileWindow>;
    request = this.http
      .get<ChangeReviewFileWindow>('/api/git/change-review/window', {
        params: {
          worktreePath,
          scope,
          path,
          offset: String(normalized.offset),
          limit: String(normalized.limit),
          context: String(normalized.context),
          forceLoad: String(forceLoad),
          forceFileLoad: String(normalized.forceFileLoad),
        },
      })
      .pipe(
        tap({
          next: () => {
            emitted = true;
          },
        }),
        finalize(() => this.dropUnresolved(this.fileWindowCache, key, request, emitted)),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
    this.fileWindowCache.set(key, request);
    return request;
  }

  getContextWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    range: {
      oldStart: number;
      newStart: number;
      count: number;
      limit?: number;
      forceFileLoad?: boolean;
    },
    forceLoad = false,
  ) {
    const normalized = {
      oldStart: range.oldStart,
      newStart: range.newStart,
      count: range.count,
      limit: range.limit ?? 120,
      forceFileLoad: Boolean(range.forceFileLoad),
    };
    const key = this.contextWindowKey(worktreePath, scope, path, normalized, forceLoad);
    const cached = this.contextWindowCache.get(key);
    if (cached) return cached;

    let emitted = false;
    let request!: Observable<ChangeReviewContextWindow>;
    request = this.http
      .get<ChangeReviewContextWindow>('/api/git/change-review/context', {
        params: {
          worktreePath,
          scope,
          path,
          oldStart: String(normalized.oldStart),
          newStart: String(normalized.newStart),
          count: String(normalized.count),
          limit: String(normalized.limit),
          forceLoad: String(forceLoad),
          forceFileLoad: String(normalized.forceFileLoad),
        },
      })
      .pipe(
        tap({
          next: () => {
            emitted = true;
          },
        }),
        finalize(() => this.dropUnresolved(this.contextWindowCache, key, request, emitted)),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
    this.contextWindowCache.set(key, request);
    return request;
  }

  getFileFingerprints(
    worktreePath: string,
    scope: ChangeReviewScope,
    paths: readonly string[],
    forceLoad = false,
  ) {
    return this.http.post<ChangeReviewFileFingerprintsResponse>(
      '/api/git/change-review/fingerprints',
      {
        worktreePath,
        scope,
        paths,
        forceLoad,
      },
    );
  }

  hasFileWindowCache(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: {
      offset?: number;
      limit?: number;
      context?: number;
      forceFileLoad?: boolean;
    } = {},
    forceLoad = false,
  ): boolean {
    return this.fileWindowCache.has(
      this.fileWindowKey(
        worktreePath,
        scope,
        path,
        {
          offset: options.offset ?? 0,
          limit: options.limit ?? 600,
          context: options.context ?? 8,
          forceFileLoad: Boolean(options.forceFileLoad),
        },
        forceLoad,
      ),
    );
  }

  clearCache(worktreePath?: string, scope?: ChangeReviewScope): void {
    const prefix = worktreePath
      ? scope
        ? this.scopePrefix(worktreePath, scope)
        : `${worktreePath}\0`
      : null;
    this.clearMap(this.summaryCache, prefix);
    this.clearMap(this.fileWindowCache, prefix);
    this.clearMap(this.contextWindowCache, prefix);
  }

  private clearMap<T>(cache: Map<string, T>, prefix: string | null): void {
    if (!prefix) {
      cache.clear();
      return;
    }
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }

  private dropUnresolved<T>(
    cache: Map<string, Observable<T>>,
    key: string,
    request: Observable<T>,
    emitted: boolean,
  ): void {
    if (!emitted && cache.get(key) === request) {
      cache.delete(key);
    }
  }

  private summaryKey(worktreePath: string, scope: ChangeReviewScope, forceLoad: boolean): string {
    return `${this.scopePrefix(worktreePath, scope)}\0summary\0${forceLoad ? 'force' : 'guarded'}`;
  }

  private fileWindowKey(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: {
      offset: number;
      limit: number;
      context: number;
      forceFileLoad: boolean;
    },
    forceLoad: boolean,
  ): string {
    return [
      this.scopePrefix(worktreePath, scope),
      'file',
      path,
      options.offset,
      options.limit,
      options.context,
      options.forceFileLoad ? 'force-file' : 'guarded-file',
      forceLoad ? 'force' : 'guarded',
    ].join('\0');
  }

  private contextWindowKey(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    range: {
      oldStart: number;
      newStart: number;
      count: number;
      limit: number;
      forceFileLoad: boolean;
    },
    forceLoad: boolean,
  ): string {
    return [
      this.scopePrefix(worktreePath, scope),
      'context',
      path,
      range.oldStart,
      range.newStart,
      range.count,
      range.limit,
      range.forceFileLoad ? 'force-file' : 'guarded-file',
      forceLoad ? 'force' : 'guarded',
    ].join('\0');
  }

  private scopePrefix(worktreePath: string, scope: ChangeReviewScope): string {
    return `${worktreePath}\0${scope}`;
  }
}
