import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, shareReplay, tap } from 'rxjs';
import {
  ConsumeWorktreeContextResult,
  WorktreeContextSnapshot,
} from '../models/worktree-context.model';
import type { AgentProviderId } from '../models/agent-runtime.model';

@Injectable({ providedIn: 'root' })
export class WorktreeContextService {
  private readonly http = inject(HttpClient);

  private readonly inFlightGet = new Map<string, Observable<WorktreeContextSnapshot>>();
  private readonly inFlightGenerate = new Map<string, Observable<WorktreeContextSnapshot>>();

  get(
    repoId: number,
    worktreePath: string,
    options: { cachedOnly?: boolean } = {},
  ): Observable<WorktreeContextSnapshot> {
    const key = this.cacheKey(repoId, `${options.cachedOnly ? 'cached:' : ''}${worktreePath}`);
    const existing = this.inFlightGet.get(key);
    if (existing) {
      return existing;
    }

    let params = new HttpParams()
      .set('repoId', String(repoId))
      .set('worktreePath', worktreePath);
    if (options.cachedOnly) {
      params = params.set('cachedOnly', 'true');
    }
    const request = this.http
      .get<WorktreeContextSnapshot>('/api/worktree-context', { params })
      .pipe(
        tap({
          next: () => this.inFlightGet.delete(key),
          error: () => this.inFlightGet.delete(key),
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    this.inFlightGet.set(key, request);
    return request;
  }

  generate(
    repoId: number,
    worktreePath: string,
    options: { force?: boolean; rootRef?: string | null; provider: AgentProviderId },
  ): Observable<WorktreeContextSnapshot> {
    const key = this.cacheKey(repoId, `${options.provider}:${worktreePath}`);
    if (!options.force && options.rootRef === undefined) {
      const existing = this.inFlightGenerate.get(key);
      if (existing) {
        return existing;
      }
    }

    const request = this.http
      .post<WorktreeContextSnapshot>('/api/worktree-context/generate', {
        repoId,
        worktreePath,
        force: options.force,
        rootRef: options.rootRef,
        provider: options.provider,
      })
      .pipe(
        tap({
          next: () => this.inFlightGenerate.delete(key),
          error: () => this.inFlightGenerate.delete(key),
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );

    if (!options.force && options.rootRef === undefined) {
      this.inFlightGenerate.set(key, request);
    }
    return request;
  }

  updateRootRef(repoId: number, worktreePath: string, rootRef: string | null) {
    return this.http.put<WorktreeContextSnapshot>('/api/worktree-context/root-ref', {
      repoId,
      worktreePath,
      rootRef,
    });
  }

  consume(sessionId: number, enabled: boolean, contextSentence?: string) {
    return this.http.post<ConsumeWorktreeContextResult>('/api/worktree-context/consume', {
      sessionId,
      enabled,
      contextSentence,
    });
  }

  private cacheKey(repoId: number, worktreePath: string): string {
    return `${repoId}:${worktreePath}`;
  }
}
