import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
import {
  ChangeReviewContextWindow,
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

  getSummary(worktreePath: string, scope: ChangeReviewScope, refreshBase = false) {
    if (refreshBase) {
      this.clearCache(worktreePath, scope);
    }
    const key = this.summaryKey(worktreePath, scope);
    const cached = this.summaryCache.get(key);
    if (cached) return cached;

    const request = this.http.get<ChangeReviewSummary>('/api/git/change-review/summary', {
      params: {
        worktreePath,
        scope,
        refreshBase: String(refreshBase),
      },
    }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this.summaryCache.set(key, request);
    return request;
  }

  getFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: { offset?: number; limit?: number; context?: number } = {},
  ) {
    const normalized = {
      offset: options.offset ?? 0,
      limit: options.limit ?? 600,
      context: options.context ?? 8,
    };
    const key = this.fileWindowKey(worktreePath, scope, path, normalized);
    const cached = this.fileWindowCache.get(key);
    if (cached) return cached;

    const request = this.http.get<ChangeReviewFileWindow>('/api/git/change-review/window', {
      params: {
        worktreePath,
        scope,
        path,
        offset: String(normalized.offset),
        limit: String(normalized.limit),
        context: String(normalized.context),
      },
    }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this.fileWindowCache.set(key, request);
    return request;
  }

  getContextWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    range: { oldStart: number; newStart: number; count: number; limit?: number },
  ) {
    const normalized = {
      oldStart: range.oldStart,
      newStart: range.newStart,
      count: range.count,
      limit: range.limit ?? 120,
    };
    const key = this.contextWindowKey(worktreePath, scope, path, normalized);
    const cached = this.contextWindowCache.get(key);
    if (cached) return cached;

    const request = this.http.get<ChangeReviewContextWindow>('/api/git/change-review/context', {
      params: {
        worktreePath,
        scope,
        path,
        oldStart: String(normalized.oldStart),
        newStart: String(normalized.newStart),
        count: String(normalized.count),
        limit: String(normalized.limit),
      },
    }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this.contextWindowCache.set(key, request);
    return request;
  }

  hasFileWindowCache(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: { offset?: number; limit?: number; context?: number } = {},
  ): boolean {
    return this.fileWindowCache.has(this.fileWindowKey(worktreePath, scope, path, {
      offset: options.offset ?? 0,
      limit: options.limit ?? 600,
      context: options.context ?? 8,
    }));
  }

  clearCache(worktreePath?: string, scope?: ChangeReviewScope): void {
    const prefix = worktreePath && scope ? this.scopePrefix(worktreePath, scope) : null;
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

  private summaryKey(worktreePath: string, scope: ChangeReviewScope): string {
    return `${this.scopePrefix(worktreePath, scope)}\0summary`;
  }

  private fileWindowKey(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: { offset: number; limit: number; context: number },
  ): string {
    return [
      this.scopePrefix(worktreePath, scope),
      'file',
      path,
      options.offset,
      options.limit,
      options.context,
    ].join('\0');
  }

  private contextWindowKey(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    range: { oldStart: number; newStart: number; count: number; limit: number },
  ): string {
    return [
      this.scopePrefix(worktreePath, scope),
      'context',
      path,
      range.oldStart,
      range.newStart,
      range.count,
      range.limit,
    ].join('\0');
  }

  private scopePrefix(worktreePath: string, scope: ChangeReviewScope): string {
    return `${worktreePath}\0${scope}`;
  }
}
