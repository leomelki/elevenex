import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs';
import {
  CommitMessageSuggestion,
  CommitResult,
  FileStatus,
  GitStatusSummary,
  PushResult,
} from '../models/git.model';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

@Injectable({ providedIn: 'root' })
export class GitService {
  private http = inject(HttpClient);
  private providerSelection = inject(AgentRuntimeProviderService);
  private readonly latestSummaries = signal<ReadonlyMap<string, GitStatusSummary>>(new Map());

  getStatus(worktreePath: string) {
    return this.http.get<FileStatus[]>('/api/git/status', {
      params: { worktreePath },
    });
  }

  getSummary(worktreePath: string) {
    return this.http.get<GitStatusSummary>('/api/git/summary', {
      params: { worktreePath },
    }).pipe(tap((summary) => this.rememberSummary(worktreePath, summary)));
  }

  latestSummary(worktreePath: string | null): GitStatusSummary | null {
    return worktreePath ? this.latestSummaries().get(worktreePath) ?? null : null;
  }

  stageFiles(worktreePath: string, files: string[]) {
    return this.http.post<void>('/api/git/stage', { worktreePath, files });
  }

  unstageFiles(worktreePath: string, files: string[]) {
    return this.http.post<void>('/api/git/unstage', { worktreePath, files });
  }

  suggestCommitMessage(worktreePath: string) {
    return this.http.post<CommitMessageSuggestion>('/api/git/commit-message/suggest', {
      worktreePath,
      provider: this.providerSelection.currentProvider,
    });
  }

  commit(worktreePath: string, options: { message?: string; includeUnstaged?: boolean }) {
    return this.http.post<CommitResult>('/api/git/commit', {
      worktreePath,
      message: options.message,
      includeUnstaged: options.includeUnstaged ?? false,
      provider: this.providerSelection.currentProvider,
    });
  }

  push(worktreePath: string) {
    return this.http.post<PushResult>('/api/git/push', { worktreePath });
  }

  private rememberSummary(worktreePath: string, summary: GitStatusSummary): void {
    this.latestSummaries.update((current) => {
      const next = new Map(current);
      next.set(worktreePath, summary);
      return next;
    });
  }
}
