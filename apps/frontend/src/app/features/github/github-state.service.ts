import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { GithubService } from '@/shared/services/github.service';
import {
  GitHubBranchContext,
  GitHubCapabilities,
  PullRequestCheckRollup,
  PullRequestConversation,
  PullRequestDetail,
  PullRequestFileDiff,
} from '@/shared/models/github.model';

export interface WorktreeGitHubState {
  capabilities: GitHubCapabilities | null;
  branchContext: GitHubBranchContext | null;
  pullRequest: PullRequestDetail | null;
  checks: PullRequestCheckRollup | null;
  conversation: PullRequestConversation | null;
  diffFiles: PullRequestFileDiff[];
  loading: boolean;
}

const EMPTY_STATE: WorktreeGitHubState = {
  capabilities: null,
  branchContext: null,
  pullRequest: null,
  checks: null,
  conversation: null,
  diffFiles: [],
  loading: false,
};

@Injectable({ providedIn: 'root' })
export class GitHubStateService {
  private readonly githubService = inject(GithubService);
  private readonly state = signal<Map<string, WorktreeGitHubState>>(new Map());

  getState(worktreePath: string): WorktreeGitHubState {
    return this.state().get(worktreePath) ?? EMPTY_STATE;
  }

  hasCachedData(worktreePath: string): boolean {
    const s = this.state().get(worktreePath);
    return s != null && (s.capabilities != null || s.branchContext != null);
  }

  getCapabilities(worktreePath: string): GitHubCapabilities | null {
    return this.state().get(worktreePath)?.capabilities ?? null;
  }

  getBranchContext(worktreePath: string): GitHubBranchContext | null {
    return this.state().get(worktreePath)?.branchContext ?? null;
  }

  isLoading(worktreePath: string): boolean {
    return this.state().get(worktreePath)?.loading ?? false;
  }

  hasLinkedPullRequest(worktreePath: string): boolean {
    return Boolean(this.getBranchContext(worktreePath)?.linkedPullRequest);
  }

  async loadSummary(worktreePath: string, refresh = false): Promise<void> {
    this.patch(worktreePath, { loading: true });
    try {
      const [capabilities, branchContext] = await Promise.all([
        firstValueFrom(this.githubService.getCapabilities(worktreePath, refresh)),
        firstValueFrom(this.githubService.getBranchContext(worktreePath, refresh)),
      ]);
      this.patch(worktreePath, {
        capabilities,
        branchContext,
        loading: false,
      });
    } catch {
      this.patch(worktreePath, { loading: false });
    }
  }

  updateBranchContext(worktreePath: string, branchContext: GitHubBranchContext | null): void {
    this.patch(worktreePath, { branchContext });
  }

  updatePanelData(worktreePath: string, data: Partial<WorktreeGitHubState>): void {
    this.patch(worktreePath, data);
  }

  private patch(worktreePath: string, partial: Partial<WorktreeGitHubState>): void {
    const next = new Map(this.state());
    const existing = next.get(worktreePath) ?? { ...EMPTY_STATE };
    next.set(worktreePath, { ...existing, ...partial });
    this.state.set(next);
  }
}
