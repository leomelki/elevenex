import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideCheck,
  lucideChevronRight,
  lucideCircleAlert,
  lucideClock3,
  lucideExternalLink,
  lucideGitBranch,
  lucideGitCommitVertical,
  lucideGitPullRequest,
  lucideMessageSquare,
  lucideRefreshCw,
  lucideSparkles,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import { GithubService } from '@/shared/services/github.service';
import { GitService } from '@/shared/services/git.service';
import {
  GitHubBranchContext,
  GitHubCapabilities,
  PullRequestCheckRollup,
  PullRequestConversation,
  PullRequestDetail,
  PullRequestFileDiff,
} from '@/shared/models/github.model';
import { CommitMessageSuggestion, FileStatus } from '@/shared/models/git.model';
import { GitHubStateService } from './github-state.service';

type SectionKey = 'checks' | 'files' | 'activity';
type ComposeMode = 'comment' | 'approve' | 'request_changes';

export interface ActivityItem {
  id: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  type: 'review' | 'comment';
  state: string;
  body: string;
  date: string;
}

@Component({
  selector: 'app-github-panel',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardSkeletonComponent],
  templateUrl: './github-panel.component.html',
  styleUrl: './github-panel.component.scss',
  host: { class: 'block h-full overflow-hidden bg-background' },
  viewProviders: [
    provideIcons({
      lucideArrowUp,
      lucideCheck,
      lucideChevronRight,
      lucideCircleAlert,
      lucideClock3,
      lucideExternalLink,
      lucideGitBranch,
      lucideGitCommitVertical,
      lucideGitPullRequest,
      lucideMessageSquare,
      lucideRefreshCw,
      lucideSparkles,
      lucideX,
    }),
  ],
})
export class GitHubPanelComponent {
  readonly worktreePath = input.required<string>();

  private readonly githubService = inject(GithubService);
  private readonly gitService = inject(GitService);
  private readonly githubState = inject(GitHubStateService);

  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly pushing = signal(false);

  readonly capabilities = signal<GitHubCapabilities | null>(null);
  readonly branchContext = signal<GitHubBranchContext | null>(null);
  readonly pullRequest = signal<PullRequestDetail | null>(null);
  readonly checks = signal<PullRequestCheckRollup | null>(null);
  readonly conversation = signal<PullRequestConversation | null>(null);
  readonly diffFiles = signal<PullRequestFileDiff[]>([]);

  readonly expandedSections = signal<Record<SectionKey, boolean>>({
    checks: false,
    files: true,
    activity: false,
  });
  readonly expandedFiles = signal<Set<string>>(new Set());

  readonly composeMode = signal<ComposeMode>('comment');
  readonly composeBody = signal('');
  readonly sendingCompose = signal(false);
  readonly showComposeDropdown = signal(false);

  readonly commitSheetOpen = signal(false);
  readonly commitLoading = signal(false);
  readonly commitSubmitting = signal(false);
  readonly fileStatus = signal<FileStatus[]>([]);
  readonly commitSuggestion = signal<CommitMessageSuggestion | null>(null);
  readonly commitSubject = signal('');
  readonly commitBody = signal('');

  readonly stagedCount = computed(() => this.fileStatus().filter(f => f.staged).length);
  readonly unstagedCount = computed(() => this.fileStatus().filter(f => !f.staged).length);
  readonly canSubmitCommit = computed(() => this.stagedCount() > 0 && this.commitSubject().trim().length > 0);

  readonly totalDiffStats = computed(() => {
    const files = this.diffFiles();
    return {
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    };
  });

  readonly sortedActivity = computed<ActivityItem[]>(() => {
    const conv = this.conversation();
    if (!conv) return [];
    const items: ActivityItem[] = [
      ...conv.reviews.map(r => ({
        id: r.id,
        authorLogin: r.authorLogin,
        authorAvatarUrl: r.authorAvatarUrl,
        type: 'review' as const,
        state: r.state,
        body: r.body || '',
        date: r.submittedAt || '',
      })),
      ...conv.comments.map(c => ({
        id: c.id,
        authorLogin: c.authorLogin,
        authorAvatarUrl: c.authorAvatarUrl,
        type: 'comment' as const,
        state: 'COMMENTED',
        body: c.body,
        date: c.createdAt,
      })),
    ];
    return items.sort((a, b) => (a.date > b.date ? -1 : 1));
  });

  readonly activityCount = computed(() => this.sortedActivity().length);

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      if (!worktreePath) return;

      // Read state service inside untracked() so signal updates from load()
      // don't re-trigger this effect (would cause infinite loop)
      untracked(() => {
        if (this.githubState.hasCachedData(worktreePath)) {
          const cached = this.githubState.getState(worktreePath);
          this.capabilities.set(cached.capabilities);
          this.branchContext.set(cached.branchContext);
          this.pullRequest.set(cached.pullRequest);
          this.checks.set(cached.checks);
          this.conversation.set(cached.conversation);
          this.diffFiles.set(cached.diffFiles);
          this.loading.set(false);
          void this.load(worktreePath, true);
        } else {
          void this.load(worktreePath, false);
        }
      });
    });
  }

  toggleSection(key: SectionKey): void {
    const current = this.expandedSections();
    this.expandedSections.set({ ...current, [key]: !current[key] });
  }

  isSectionExpanded(key: SectionKey): boolean {
    return this.expandedSections()[key];
  }

  toggleFile(path: string): void {
    const current = new Set(this.expandedFiles());
    if (current.has(path)) {
      current.delete(path);
    } else {
      current.add(path);
    }
    this.expandedFiles.set(current);
  }

  isFileExpanded(path: string): boolean {
    return this.expandedFiles().has(path);
  }

  async refresh(): Promise<void> {
    await this.load(this.worktreePath(), true);
  }

  async push(): Promise<void> {
    this.pushing.set(true);
    try {
      const result = await firstValueFrom(this.githubService.push(this.worktreePath()));
      if (result.pushed) {
        toast.success(result.message);
      } else if (result.nonFastForward) {
        toast.error('Push rejected — branch is behind upstream.');
      } else {
        toast.error(result.message || 'Push failed.');
      }
      await this.refresh();
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not push.');
    } finally {
      this.pushing.set(false);
    }
  }

  setComposeMode(mode: ComposeMode): void {
    this.composeMode.set(mode);
    this.showComposeDropdown.set(false);
  }

  async submitAction(): Promise<void> {
    const body = this.composeBody().trim();
    if (!body && this.composeMode() === 'comment') return;

    this.sendingCompose.set(true);
    try {
      const mode = this.composeMode();
      if (mode === 'comment') {
        await firstValueFrom(this.githubService.addComment(this.worktreePath(), body));
        toast.success('Comment posted.');
      } else {
        const event = mode === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
        await firstValueFrom(this.githubService.submitReview(this.worktreePath(), event, body));
        toast.success('Review submitted.');
      }
      this.composeBody.set('');
      await this.refresh();
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not submit.');
    } finally {
      this.sendingCompose.set(false);
    }
  }

  async openCommitSheet(): Promise<void> {
    this.commitSheetOpen.set(true);
    await this.reloadFileStatus();
    if (this.stagedCount() > 0) {
      await this.generateCommitMessage();
    }
  }

  closeCommitSheet(): void {
    this.commitSheetOpen.set(false);
  }

  async toggleFileStage(file: FileStatus): Promise<void> {
    try {
      if (file.staged) {
        await firstValueFrom(this.gitService.unstageFiles(this.worktreePath(), [file.path]));
      } else {
        await firstValueFrom(this.gitService.stageFiles(this.worktreePath(), [file.path]));
      }
      await this.reloadFileStatus();
    } catch {
      toast.error('Could not update staged files.');
    }
  }

  async generateCommitMessage(): Promise<void> {
    this.commitLoading.set(true);
    try {
      const suggestion = await firstValueFrom(this.gitService.suggestCommitMessage(this.worktreePath()));
      this.commitSuggestion.set(suggestion);
      this.commitSubject.set(suggestion.subject);
      this.commitBody.set(suggestion.body ?? '');
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not generate a commit message.');
    } finally {
      this.commitLoading.set(false);
    }
  }

  async commit(pushAfter: boolean): Promise<void> {
    if (!this.canSubmitCommit()) return;
    this.commitSubmitting.set(true);
    try {
      const message = this.commitBody().trim()
        ? `${this.commitSubject().trim()}\n\n${this.commitBody().trim()}`
        : this.commitSubject().trim();
      await firstValueFrom(this.gitService.commit(this.worktreePath(), { message }));
      toast.success('Commit created.');
      if (pushAfter) {
        await this.push();
      }
      this.closeCommitSheet();
      await this.refresh();
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not create commit.');
    } finally {
      this.commitSubmitting.set(false);
    }
  }

  openPullRequest(): void {
    const url = this.pullRequest()?.url;
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  statusTone(bucket: string): 'pass' | 'fail' | 'pending' {
    if (bucket === 'pass') return 'pass';
    if (bucket === 'fail' || bucket === 'cancel') return 'fail';
    return 'pending';
  }

  fileBasename(path: string): string {
    return path.split('/').pop() || path;
  }

  statusLetter(status: string): string {
    return (status[0] || '?').toUpperCase();
  }

  composeModeLabel(): string {
    switch (this.composeMode()) {
      case 'comment': return 'Comment';
      case 'approve': return 'Approve';
      case 'request_changes': return 'Request changes';
    }
  }

  private async load(worktreePath: string, refresh: boolean): Promise<void> {
    if (refresh) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }

    try {
      const [capabilities, branchContext] = await Promise.all([
        firstValueFrom(this.githubService.getCapabilities(worktreePath, refresh)),
        firstValueFrom(this.githubService.getBranchContext(worktreePath, refresh)),
      ]);

      this.capabilities.set(capabilities);
      this.branchContext.set(branchContext);
      this.githubState.updatePanelData(worktreePath, { capabilities, branchContext });

      const canLoadPR = capabilities.ghInstalled
        && capabilities.authenticated
        && capabilities.hasGitHubRemote
        && Boolean(branchContext.linkedPullRequest);

      if (!canLoadPR) {
        this.pullRequest.set(null);
        this.checks.set({ summary: { total: 0, passing: 0, failing: 0, pending: 0 }, checks: [] });
        this.conversation.set({ reviews: [], comments: [], threads: [] });
        this.diffFiles.set([]);
        this.githubState.updatePanelData(worktreePath, {
          pullRequest: null, checks: null, conversation: null, diffFiles: [],
        });
        return;
      }

      const [pullRequest, checks, conversation, diffFiles] = await Promise.all([
        firstValueFrom(this.githubService.getPullRequest(worktreePath, refresh)),
        firstValueFrom(this.githubService.getPullRequestChecks(worktreePath, refresh)),
        firstValueFrom(this.githubService.getPullRequestConversation(worktreePath, refresh)),
        firstValueFrom(this.githubService.getPullRequestDiff(worktreePath, refresh)),
      ]);

      this.pullRequest.set(pullRequest);
      this.checks.set(checks);
      this.conversation.set(conversation);
      this.diffFiles.set(diffFiles);
      this.githubState.updatePanelData(worktreePath, {
        pullRequest, checks, conversation, diffFiles,
      });

      const sections = { ...this.expandedSections() };
      if (checks && checks.summary.failing > 0) sections.checks = true;
      if (diffFiles.length <= 15) sections.files = true;
      this.expandedSections.set(sections);
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not load GitHub data.');
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  private async reloadFileStatus(): Promise<void> {
    this.commitLoading.set(true);
    try {
      const files = await firstValueFrom(this.gitService.getStatus(this.worktreePath()));
      this.fileStatus.set(files);
    } catch {
      toast.error('Could not load git status.');
    } finally {
      this.commitLoading.set(false);
    }
  }
}
