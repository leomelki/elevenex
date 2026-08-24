import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
import {
  CreatePoolWorktreePayload,
  CreateWorktreeJob,
  CreateWorktreeJobStatus,
  LinkPoolWorktreePayload,
  WorktreeInfo,
  WorktreePoolItem,
} from '../models/worktree.model';
import { Workspace } from '../models/workspace.model';
import { getApiBaseUrl } from '../runtime/runtime-config';

@Injectable({ providedIn: 'root' })
export class WorktreesService {
  private http = inject(HttpClient);

  getByRepo(repoId: number) {
    return this.http.get<WorktreeInfo[]>(`/api/repos/${repoId}/worktrees`);
  }

  getPoolByRepo(repoId: number) {
    return this.http.get<WorktreePoolItem[]>(`/api/repos/${repoId}/worktree-pool`);
  }

  getPoolByRepoStream(repoId: number) {
    return new Observable<WorktreePoolItem[]>((subscriber) => {
      const source = new EventSource(
        `${getApiBaseUrl()}/repos/${repoId}/worktree-pool/stream`,
      );
      const items: WorktreePoolItem[] = [];
      let closed = false;
      let fallbackSubscription: Subscription | null = null;

      const onWorktree = (event: MessageEvent) => {
        if (closed) return;
        try {
          const item = JSON.parse(event.data) as WorktreePoolItem;
          const existingIndex = items.findIndex(
            (candidate) => candidate.id === item.id,
          );
          if (existingIndex === -1) {
            items.push(item);
          } else {
            items[existingIndex] = item;
          }
          subscriber.next([...items]);
        } catch (error) {
          closed = true;
          source.close();
          subscriber.error(error);
        }
      };

      const onDone = () => {
        if (closed) return;
        closed = true;
        source.close();
        subscriber.complete();
      };

      const onError = () => {
        if (closed) return;
        closed = true;
        source.close();

        // EventSource exposes neither the HTTP status nor the response body
        // when the stream is interrupted, which previously produced the
        // unhelpful "Could not load worktrees" toast. Retry through HttpClient:
        // it is also more tolerant of proxies that do not support SSE and
        // preserves the backend's actual error response if loading really fails.
        fallbackSubscription = this.getPoolByRepo(repoId).subscribe({
          next: (fallbackItems) => subscriber.next(fallbackItems),
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });
      };

      source.addEventListener('worktree', onWorktree);
      source.addEventListener('done', onDone);
      source.addEventListener('error', onError);

      return () => {
        closed = true;
        source.close();
        fallbackSubscription?.unsubscribe();
      };
    });
  }

  createPool(repoId: number, payload: CreatePoolWorktreePayload) {
    return this.http.post<WorktreePoolItem>(`/api/repos/${repoId}/worktree-pool`, payload);
  }

  linkPool(repoId: number, worktreeId: number, payload: LinkPoolWorktreePayload) {
    return this.http.post<Workspace>(`/api/repos/${repoId}/worktree-pool/${worktreeId}/link`, payload);
  }

  renamePool(repoId: number, worktreeId: number, name: string) {
    return this.http.patch<WorktreePoolItem>(`/api/repos/${repoId}/worktree-pool/${worktreeId}`, { name });
  }

  create(repoId: number, branchName: string, worktreePath?: string) {
    return this.http.post<CreateWorktreeJob>(`/api/repos/${repoId}/worktrees`, { branchName, worktreePath });
  }

  getCreateJob(repoId: number, jobId: string) {
    return this.http.get<CreateWorktreeJobStatus>(`/api/repos/${repoId}/worktrees/jobs/${jobId}`);
  }

  remove(repoId: number, worktreePath: string) {
    return this.http.delete<void>(`/api/repos/${repoId}/worktrees`, { body: { worktreePath } });
  }

  removeFromProject(repoId: number, worktreePath: string) {
    return this.http.delete<void>(`/api/repos/${repoId}/worktrees/project-attachment`, {
      body: { worktreePath },
    });
  }
}
