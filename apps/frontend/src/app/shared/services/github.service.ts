import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  GitHubBranchContext,
  GitHubCapabilities,
  PullRequestCheckRollup,
  PullRequestConversation,
  PullRequestDetail,
  PullRequestFileDiff,
} from '../models/github.model';
import { PushResult } from '../models/git.model';

@Injectable({ providedIn: 'root' })
export class GithubService {
  private http = inject(HttpClient);

  getCapabilities(worktreePath: string, refresh = false) {
    return this.http.get<GitHubCapabilities>('/api/github/capabilities', {
      params: {
        worktreePath,
        refresh: String(refresh),
      },
    });
  }

  getBranchContext(worktreePath: string, refresh = false) {
    return this.http.get<GitHubBranchContext>('/api/github/branch-context', {
      params: {
        worktreePath,
        refresh: String(refresh),
      },
    });
  }

  getPullRequest(worktreePath: string, refresh = false) {
    return this.http.get<PullRequestDetail | null>('/api/github/pull-request', {
      params: {
        worktreePath,
        refresh: String(refresh),
      },
    });
  }

  getPullRequestDiff(worktreePath: string, refresh = false) {
    return this.http.get<PullRequestFileDiff[]>('/api/github/pull-request/diff', {
      params: {
        worktreePath,
        refresh: String(refresh),
      },
    });
  }

  getPullRequestConversation(worktreePath: string, refresh = false) {
    return this.http.get<PullRequestConversation>('/api/github/pull-request/conversation', {
      params: {
        worktreePath,
        refresh: String(refresh),
      },
    });
  }

  getPullRequestChecks(worktreePath: string, refresh = false) {
    return this.http.get<PullRequestCheckRollup>('/api/github/pull-request/checks', {
      params: {
        worktreePath,
        refresh: String(refresh),
      },
    });
  }

  addComment(worktreePath: string, comment: string) {
    return this.http.post<{ success: boolean }>('/api/github/pull-request/comment', {
      worktreePath,
      comment,
    });
  }

  submitReview(
    worktreePath: string,
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
    body: string,
  ) {
    return this.http.post<{ success: boolean }>('/api/github/pull-request/review', {
      worktreePath,
      event,
      body,
    });
  }

  push(worktreePath: string) {
    return this.http.post<PushResult>('/api/github/push', { worktreePath });
  }
}
