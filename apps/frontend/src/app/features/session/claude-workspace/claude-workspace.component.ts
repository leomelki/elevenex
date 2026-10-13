import { McpManagerStore } from './mcp-manager.store';
import {
  ZardResizableComponent,
  ZardResizablePanelComponent,
  ZardResizableHandleComponent,
} from '@/shared/components/resizable';
import { OpenCodeLoginCardComponent } from './components/opencode-login-card.component';
import { PlanFeedbackPayload, PlanReviewRequest } from '@/features/plan-annotator';
import { ClaudeAgentInspectorComponent } from '@/shared/agent-chat/activity/claude-agent-inspector.component';
import { SubagentOverviewComponent } from '@/shared/agent-chat/activity/subagent-overview.component';
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
import { ClaudeMcpServerEntry } from '@/shared/models/claude-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentShowsService } from '@/shared/services/agent-shows.service';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { CommonModule } from '@angular/common';
import {
  afterRenderEffect,
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
  lucideTerminal,
  lucideNotebookPen,
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

@Component({
  selector: 'app-claude-workspace',
  standalone: true,
  imports: [
    ZardResizableComponent,
    ZardResizablePanelComponent,
    ZardResizableHandleComponent,
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
    SubagentOverviewComponent,
    ClaudeTranscriptComponent,
    ClaudeContextNoteComponent,
    ClaudeInstallCardComponent,
    CodexLoginCardComponent,
    PiLoginCardComponent,
    OpenCodeLoginCardComponent,
    AgentShowCardComponent,
    TranscriptLoadingSkeletonComponent,
    NgIcon,
    ZardButtonComponent,
  ],
  templateUrl: './claude-workspace.component.html',
  styleUrls: ['./claude-workspace.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SessionRuntime, SessionDraftContext, SessionMessageActions, McpManagerStore],
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
      lucideTerminal,
      lucideNotebookPen,
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
  readonly mcp = inject(McpManagerStore);
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

  readonly mcpDrawerOpen = this.mcp.open;

  readonly exportDialogOpen = signal(false);

  readonly exportBusy = signal(false);

  readonly mcpLoading = this.mcp.loading;

  readonly mcpSnapshot = this.mcp.snapshot;

  readonly mcpBusyServerName = this.mcp.busy;
  constructor() {
    this.mcp.bind(this.sessionId, this.runtime.currentProvider, this.isVisible);
    this.mcp.authorization.pipe(takeUntilDestroyed()).subscribe(result => {
      this.openInBrowser.emit(result.url);
      toast.message(result.message);
    });
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
    afterRenderEffect(() => {
      if (this.isVisible() && !this.hasStartedAgentRuntime() && !this.runtime.isTranscriptReadOnly())
        this.composer()?.focusAtEnd();
    });
    for (const source of [this.draft.focusRequested, this.actions.focusRequested])
      source
        .pipe(takeUntilDestroyed())
        .subscribe(() => queueMicrotask(() => {
          if (this.isVisible()) this.composer()?.focusAtEnd();
        }));
    this.runtime.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'focus-composer') queueMicrotask(() => this.composer()?.focusAtEnd());
      if (event.type === 'complete' && this.mcpDrawerOpen()) void this.mcp.load(true);
      if (event.type === 'reset') {
        this.mcp.reset();
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
    this.mcp.show();
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

  closeMcpDrawer(): void { this.mcp.close(); }

  refreshMcpSnapshot(): void { void this.mcp.load(); }

  toggleMcpServer(server: ClaudeMcpServerEntry): void { this.mcp.toggle(server); }

  recheckMcpServer(server: ClaudeMcpServerEntry): void { this.mcp.check(server); }

  startMcpAuth(server: ClaudeMcpServerEntry): void { void this.mcp.authenticate(server); }
}
