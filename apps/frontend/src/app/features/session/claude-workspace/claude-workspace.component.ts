import { PlanFeedbackPayload, PlanReviewRequest } from '@/features/plan-annotator';
import { ClaudeAgentInspectorComponent } from '@/shared/agent-chat/activity/claude-agent-inspector.component';
import { ClaudeBackgroundActivityComponent } from '@/shared/agent-chat/activity/claude-background-activity.component';
import { ClaudeComposerComponent } from '@/shared/agent-chat/composer/claude-composer.component';
import { ClaudePermissionInlineComponent } from '@/shared/agent-chat/requests/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/shared/agent-chat/requests/claude-user-input.component';
import { TranscriptLoadingSkeletonComponent } from '@/shared/agent-chat/transcript-loading-skeleton.component';
import { ClaudeContextNoteComponent } from '@/shared/agent-chat/transcript/claude-context-note.component';
import { ClaudeTranscriptComponent } from '@/shared/agent-chat/transcript/claude-transcript.component';
import { TranscriptViewportDirective } from '@/shared/agent-chat/transcript/transcript-viewport.directive';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import type { AgentShow } from '@/shared/models/agent-channel.model';
import { AgentProviderId } from '@/shared/models/agent-runtime.model';
import { ClaudeMcpServerEntry, ClaudeMcpSnapshot } from '@/shared/models/claude-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentShowsService } from '@/shared/services/agent-shows.service';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnChanges,
  OnInit,
  SimpleChanges,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { outputFromObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideArchiveRestore,
  lucideArrowUp,
  lucideCheck,
  lucideChevronDown,
  lucideChevronUp,
  lucideFileText,
  lucideGitBranch,
  lucideMessageSquareQuote,
  lucideNotebookPen,
  lucideOrbit,
  lucideRefreshCw,
  lucideSparkles,
  lucideTriangleAlert,
  lucideWandSparkles,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import type { Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { AgentShowCardComponent } from './components/agent-show-card.component';
import {
  ClaudeExportDialogComponent,
  type ExportRequest,
} from './components/claude-export-dialog.component';
import { ClaudeInstallCardComponent } from './components/claude-install-card.component';
import { ClaudeMcpDrawerComponent } from './components/claude-mcp-drawer.component';
import { ClaudeStatusBarComponent } from './components/claude-status-bar.component';
import { ClaudeTasksDrawerComponent } from './components/claude-tasks-drawer.component';
import { CodexLoginCardComponent } from './components/codex-login-card.component';
import { PiLoginCardComponent } from './components/pi-login-card.component';
import { SessionDraftContext } from './session-draft-context.service';
import { SessionMessageActions } from './session-message-actions.service';
import { SessionRuntime } from './session-runtime.service';
import { getHttpErrorMessage } from './workspace-error';

@Component({
  selector: 'app-claude-workspace',
  standalone: true,
  imports: [
    CommonModule,
    TranscriptViewportDirective,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
    ClaudeComposerComponent,
    ClaudeStatusBarComponent,
    ClaudeBackgroundActivityComponent,
    ClaudeExportDialogComponent,
    ClaudeTasksDrawerComponent,
    ClaudeMcpDrawerComponent,
    ClaudeAgentInspectorComponent,
    ClaudeTranscriptComponent,
    ClaudeContextNoteComponent,
    ClaudeInstallCardComponent,
    CodexLoginCardComponent,
    PiLoginCardComponent,
    AgentShowCardComponent,
    TranscriptLoadingSkeletonComponent,
    NgIcon,
    ZardButtonComponent,
  ],
  templateUrl: './claude-workspace.component.html',
  styleUrls: ['./claude-workspace.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SessionRuntime, SessionDraftContext, SessionMessageActions],
  viewProviders: [
    provideIcons({
      lucideWandSparkles,
      lucideChevronDown,
      lucideChevronUp,
      lucideGitBranch,
      lucideTriangleAlert,
      lucideRefreshCw,
      lucideArchive,
      lucideArchiveRestore,
      lucideCheck,
      lucideFileText,
      lucideNotebookPen,
      lucideOrbit,
      lucideSparkles,
      lucideArrowUp,
      lucideMessageSquareQuote,
    }),
  ],
})
export class ClaudeWorkspaceComponent implements OnInit, OnChanges {
  readonly runtime = inject(SessionRuntime);
  readonly draft = inject(SessionDraftContext);
  readonly actions = inject(SessionMessageActions);
  private readonly api = inject(ClaudeRuntimeApiService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);
  private mcpRequestVersion = 0;
  private mcpSnapshotVersion = 0;
  private readonly navigationService = inject(NavigationService);
  readonly viewport = viewChild(TranscriptViewportDirective);
  private readonly composer = viewChild(ClaudeComposerComponent);
  readonly sessionId = input.required<number>();
  readonly repoId = input.required<number>();
  readonly worktreePath = input.required<string>();
  readonly hasInjectedWorktreeContext = input(false);
  readonly activeAgentProvider = input<AgentProviderId>('claude');
  readonly hasStartedAgentRuntime = input(false);
  readonly isVisible = input(true);
  readonly archived = input(false);
  readonly readOnlyTranscript = input(false);
  readonly terminalTranscriptMirror = input(false);
  readonly sessionName = input<string | null>(null);
  readonly unarchiveBusy = input(false);
  readonly planReviewRequested = outputFromObservable(this.actions.planReviewRequested);
  readonly planQuestionRequested = outputFromObservable(this.actions.planQuestionRequested);
  readonly planReviewClosed = outputFromObservable(this.actions.planReviewClosed);
  readonly conversationForkCreated = outputFromObservable(this.actions.conversationForkCreated);
  readonly conversationForkOpened = outputFromObservable(this.actions.conversationForkOpened);
  readonly activeAgentProviderChange = outputFromObservable(this.runtime.activeAgentProviderChange);
  readonly agentRuntimeStarted = outputFromObservable(this.runtime.agentRuntimeStarted);
  readonly openTerminalFallback = outputFromObservable(this.runtime.openTerminalFallback);

  readonly openInBrowser = output<string>();

  /** Ask the container to open the review workspace, optionally deep-linked. */
  readonly openReviewWorkspace = output<{ path?: string; thread?: number }>();

  readonly openLocalFile = output<LocalFileTarget>();

  readonly unarchive = output<void>();

  private readonly agentShowsService = inject(AgentShowsService);

  readonly liveShows = computed<AgentShow[]>(() =>
    this.agentShowsService.liveShows().filter((s) => s.agentSessionId === this.sessionId()),
  );

  readonly tasksDrawerOpen = signal(false);

  readonly mcpDrawerOpen = signal(false);

  readonly exportDialogOpen = signal(false);

  readonly exportBusy = signal(false);

  readonly mcpLoading = signal(false);

  readonly mcpSnapshot = signal<ClaudeMcpSnapshot | null>(null);

  readonly mcpBusyServerName = signal<string | null>(null);
  constructor() {
    this.runtime.bindInputs({
      sessionId: this.sessionId,
      repoId: this.repoId,
      worktreePath: this.worktreePath,
      hasInjectedWorktreeContext: this.hasInjectedWorktreeContext,
      activeAgentProvider: this.activeAgentProvider,
      hasStartedAgentRuntime: this.hasStartedAgentRuntime,
      isVisible: this.isVisible,
      archived: this.archived,
      readOnlyTranscript: this.readOnlyTranscript,
      terminalTranscriptMirror: this.terminalTranscriptMirror,
    });
    for (const source of [this.draft.focusRequested, this.actions.focusRequested])
      source
        .pipe(takeUntilDestroyed())
        .subscribe(() => queueMicrotask(() => this.composer()?.focusAtEnd()));
    this.runtime.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'focus-composer') queueMicrotask(() => this.composer()?.focusAtEnd());
      if (event.type === 'complete' && this.mcpDrawerOpen()) void this.loadMcpSnapshot(true);
      if (event.type === 'reset') {
        this.mcpRequestVersion++;
        this.mcpSnapshotVersion++;
        this.exportDialogOpen.set(false);
        this.exportBusy.set(false);
        this.tasksDrawerOpen.set(false);

        this.mcpDrawerOpen.set(false);

        this.mcpLoading.set(false);

        this.mcpSnapshot.set(null);

        this.mcpBusyServerName.set(null);
        this.viewport()?.reset();
      }
    });
  }
  ngOnInit(): void {
    this.runtime.initialize();
  }
  ngOnChanges(changes: SimpleChanges): void {
    this.runtime.onInputsChanged(changes);
  }
  @HostListener('document:mousedown', ['$event']) onDocumentMousedown(event: MouseEvent): void {
    this.actions.onDocumentMousedown(event);
  }
  @HostListener('document:keydown.escape') onEscape(): void {
    this.actions.cancelArmedEdit();
  }
  // Public commands used by the session host.
  addDiffMentions(mentions: readonly DiffSelectionMention[]): void {
    this.draft.addDiffMentions(mentions);
  }
  approvePlanReview(review: PlanReviewRequest): Promise<void> {
    return this.actions.approvePlanReview(review);
  }
  sendPlanReviewFeedback(payload: PlanFeedbackPayload): Promise<void> {
    return this.actions.sendPlanReviewFeedback(payload);
  }
  rejectPlanReview(payload: PlanFeedbackPayload): Promise<void> {
    return this.actions.rejectPlanReview(payload);
  }

  dismissShow(id: string): void {
    this.agentShowsService.dismiss(id);
  }

  openShowDeepLink(deepLink: string): void {
    const sessionMatch = /^\/sessions\/(\d+)/.exec(deepLink);
    if (sessionMatch) {
      this.navigationService.openSession(Number(sessionMatch[1]));
      return;
    }
    const projectMatch = /^\/projects\/(\d+)/.exec(deepLink);
    if (projectMatch) {
      this.navigationService.revealProject(Number(projectMatch[1]));
      return;
    }
    window.open(deepLink, '_blank', 'noopener');
  }

  openMcpDrawer(): void {
    this.mcpDrawerOpen.set(true);
    void this.loadMcpSnapshot();
  }

  openExportDialog(): void {
    this.exportDialogOpen.set(true);
  }

  async onExportCopy(request: ExportRequest): Promise<void> {
    if (this.exportBusy()) return;
    const version = this.runtime.bootstrapVersion;
    const sessionId = this.sessionId();
    const isCurrent = () =>
      this.runtime.isCurrentConversation(version) && sessionId === this.sessionId();
    this.exportBusy.set(true);
    try {
      const markdown = await firstValueFrom(
        this.agentApi.exportConversation(this.sessionId(), request, this.activeAgentProvider()),
      );
      if (!isCurrent()) return;
      await navigator.clipboard.writeText(markdown);
      if (!isCurrent()) return;
      this.exportDialogOpen.set(false);
      toast.success('Conversation copied to clipboard');
    } catch {
      if (isCurrent()) toast.error('Failed to export conversation');
    } finally {
      if (isCurrent()) this.exportBusy.set(false);
    }
  }

  closeMcpDrawer(): void {
    this.mcpRequestVersion++;
    this.mcpSnapshotVersion++;
    this.mcpLoading.set(false);
    this.mcpDrawerOpen.set(false);
    this.mcpBusyServerName.set(null);
  }

  refreshMcpSnapshot(): void {
    void this.loadMcpSnapshot(true);
  }

  toggleMcpServer(server: ClaudeMcpServerEntry): void {
    void this.updateMcpServer(
      server,
      () => this.api.toggleMcpServer(this.sessionId(), server.name),
      (snapshot) => {
        this.mcpSnapshot.set(snapshot);
        toast.success(`${server.enabled ? 'Disabled' : 'Enabled'} ${server.name}`);
      },
      `Could not update ${server.name}.`,
    );
  }

  recheckMcpServer(server: ClaudeMcpServerEntry): void {
    void this.updateMcpServer(
      server,
      () => this.api.recheckMcpServer(this.sessionId(), server.name),
      (snapshot) => this.mcpSnapshot.set(snapshot),
      `Could not recheck ${server.name}.`,
    );
  }

  startMcpAuth(server: ClaudeMcpServerEntry): void {
    void this.updateMcpServer(
      server,
      () => this.api.startMcpAuth(this.sessionId(), server.name),
      (result) => {
        this.openInBrowser.emit(result.url);
        toast.message(result.message);
      },
      `Could not start auth for ${server.name}.`,
      false,
    );
  }

  private async updateMcpServer<T>(
    server: ClaudeMcpServerEntry,
    request: () => Observable<T>,
    apply: (result: T) => void,
    fallback: string,
    showLoading = true,
  ): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    const requestVersion = ++this.mcpRequestVersion;
    this.mcpSnapshotVersion++;
    const isCurrent = () =>
      this.runtime.isCurrentConversation(version) && requestVersion === this.mcpRequestVersion;
    this.mcpBusyServerName.set(server.name);
    if (showLoading) this.mcpLoading.set(true);
    try {
      const result = await firstValueFrom(request().pipe(takeUntilDestroyed(this.destroyRef)));
      if (isCurrent()) apply(result);
    } catch (error) {
      if (isCurrent()) toast.error(getHttpErrorMessage(error, fallback));
    } finally {
      if (isCurrent()) {
        this.mcpBusyServerName.set(null);
        this.mcpLoading.set(false);
      }
    }
  }

  private async loadMcpSnapshot(forceRefresh = false): Promise<void> {
    const requestVersion = ++this.mcpSnapshotVersion;
    const version = this.runtime.bootstrapVersion;
    this.mcpLoading.set(true);
    try {
      const snapshot = await firstValueFrom(
        this.api.getMcpSnapshot(this.sessionId(), forceRefresh),
      );
      if (
        version !== this.runtime.bootstrapVersion ||
        requestVersion !== this.mcpSnapshotVersion ||
        this.destroyRef.destroyed
      )
        return;
      this.mcpSnapshot.set(snapshot);
    } catch (error) {
      if (
        version !== this.runtime.bootstrapVersion ||
        requestVersion !== this.mcpSnapshotVersion ||
        this.destroyRef.destroyed
      )
        return;
      toast.error(getHttpErrorMessage(error, 'Could not load MCP servers.'));
    } finally {
      if (
        version !== this.runtime.bootstrapVersion ||
        requestVersion !== this.mcpSnapshotVersion ||
        this.destroyRef.destroyed
      )
        return;
      this.mcpLoading.set(false);
    }
  }
}
