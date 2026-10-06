import { TabService } from '@/features/session/tab-service';
import { AgentChatConnection } from '@/shared/agent-chat/agent-chat-connection';
import { AgentConversation } from '@/shared/agent-chat/agent-conversation';
import { AgentMarkdownComponent } from '@/shared/agent-chat/markdown/agent-markdown.component';
import { ClaudePermissionInlineComponent } from '@/shared/agent-chat/requests/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/shared/agent-chat/requests/claude-user-input.component';
import type { AgentShow } from '@/shared/models/agent-channel.model';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type {
  ClaudePermissionApproval,
  ClaudeRuntimeEvent,
  ClaudeToolUseSummary,
} from '@/shared/models/claude-runtime.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentShowsService } from '@/shared/services/agent-shows.service';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideActivity,
  lucideAlertTriangle,
  lucideArchive,
  lucideArrowDown,
  lucideBell,
  lucideBrain,
  lucideCheck,
  lucideChevronRight,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCircleStop,
  lucideClock,
  lucideCpu,
  lucideDatabase,
  lucideFileText,
  lucideFocus,
  lucideFolderMinus,
  lucideFolderOpen,
  lucideFolderPlus,
  lucideFolderSearch,
  lucideGitBranch,
  lucideGitCompare,
  lucideGitFork,
  lucideHelpCircle,
  lucideInfo,
  lucideLayers,
  lucideLayoutDashboard,
  lucideLink,
  lucideListChecks,
  lucideListTodo,
  lucideLoader,
  lucideMessageCircle,
  lucideMessageSquare,
  lucideMonitor,
  lucidePencil,
  lucidePencilLine,
  lucidePlugZap,
  lucidePlusCircle,
  lucidePresentation,
  lucideRefreshCw,
  lucideRotateCcw,
  lucideScroll,
  lucideScrollText,
  lucideSearch,
  lucideSend,
  lucideSettings,
  lucideShield,
  lucideShieldCheck,
  lucideSparkles,
  lucideSquare,
  lucideStopCircle,
  lucideTerminal,
  lucideTimer,
  lucideTrash2,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { AgentChannelWebsocketService } from '../../agent-channel-websocket.service';
import type { MissionSummary } from '../../agent-control.model';
import {
  buildMissionGroups,
  buildMissionRows,
  type ClusterGroup,
} from './mission-conversation-timeline';

/**
 * The elevenex-native mission timeline. Unlike the embedded coding-session
 * workspace, this renders the META-agent's turns as a product experience:
 * prose speaks to you, every elevenex tool reads as a categorized in-product
 * action (not a raw MCP call), shows surface as inline cards, and approvals
 * dock at the bottom. It streams over the same `/agent-runtime` socket the
 * mission session already uses.
 */
@Component({
  selector: 'app-mission-conversation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    NgIcon,
    AgentMarkdownComponent,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
    DictateTargetDirective,
    DictationButtonComponent,
  ],
  templateUrl: './mission-conversation.component.html',
  styleUrl: './mission-conversation.component.scss',
  viewProviders: [
    provideIcons({
      lucideActivity,
      lucideAlertTriangle,
      lucideArchive,
      lucideArrowDown,
      lucideBell,
      lucideBrain,
      lucideCheck,
      lucideChevronRight,
      lucideCircleAlert,
      lucideCircleCheck,
      lucideCircleStop,
      lucideClock,
      lucideCpu,
      lucideDatabase,
      lucideFileText,
      lucideFocus,
      lucideFolderMinus,
      lucideFolderOpen,
      lucideFolderPlus,
      lucideFolderSearch,
      lucideGitBranch,
      lucideGitCompare,
      lucideGitFork,
      lucideHelpCircle,
      lucideInfo,
      lucideLayers,
      lucideLayoutDashboard,
      lucideLink,
      lucideListChecks,
      lucideListTodo,
      lucideLoader,
      lucideMessageCircle,
      lucideMessageSquare,
      lucideMonitor,
      lucidePencil,
      lucidePencilLine,
      lucidePlugZap,
      lucidePlusCircle,
      lucidePresentation,
      lucideRefreshCw,
      lucideRotateCcw,
      lucideScroll,
      lucideScrollText,
      lucideSearch,
      lucideSend,
      lucideSettings,
      lucideShield,
      lucideShieldCheck,
      lucideSparkles,
      lucideSquare,
      lucideStopCircle,
      lucideTerminal,
      lucideTimer,
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
})
export class MissionConversationComponent {
  readonly mission = input.required<MissionSummary>();

  private readonly scrollRef = viewChild<ElementRef<HTMLElement>>('scrollRef');
  private readonly composerRef = viewChild<ElementRef<HTMLTextAreaElement>>('composerRef');

  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly runtime = new AgentChatConnection(this.ws, inject(AgentRuntimeApiService));
  private readonly shows = inject(AgentShowsService);
  private readonly channel = inject(AgentChannelWebsocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tabService = inject(TabService);

  private readonly provider = computed<AgentProviderId>(
    () => this.mission().activeAgentProvider ?? 'claude',
  );

  private readonly conversation = new AgentConversation();
  readonly draft = signal('');
  readonly historyItems = this.conversation.history;
  readonly liveItems = this.conversation.live;
  readonly optimisticUserItems = this.conversation.optimistic;
  readonly runPhase = this.conversation.runPhase;
  readonly canInterrupt = this.conversation.canInterrupt;
  readonly submitting = signal(false);
  readonly lastError = this.conversation.lastError;
  readonly pendingPermission = this.conversation.pendingPermissionRequest;
  readonly pendingUserInput = this.conversation.pendingUserInputRequest;
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly expandedClusters = signal<ReadonlySet<string>>(new Set());
  readonly toolSummaries = signal<ClaudeToolUseSummary[]>([]);
  readonly elapsedLabel = signal('');
  readonly atBottom = signal(true);

  readonly isRunning = computed(() => this.runPhase() === 'running' || this.submitting());

  /** Shows pushed by the meta-agent for THIS mission, as reactive rows. */
  private readonly missionShows = computed<AgentShow[]>(() =>
    this.shows.liveShows().filter((s) => s.agentSessionId === this.mission().sessionId),
  );

  readonly rows = computed(() => buildMissionRows(this.conversation.items(), this.missionShows()));

  /**
   * The timeline as render groups. A whole turn's work — the agent's tool
   * calls, thinking, and intermediate messages — folds into a single cluster
   * that collapses once the agent is idle, leaving just the user prompt and the
   * turn's final reply in view, with everything else one click away. Standalone
   * artifacts (shows/errors) and user prompts stay inline and break clusters.
   *
   * "Final reply" means the last assistant message before the next user prompt
   * (or the end of the transcript); earlier assistant messages are intermediate
   * narration and fold in. While the run is live the cluster stays expanded (see
   * `isLiveCluster`), so each step still shows individually until it completes.
   */
  readonly groups = computed(() => buildMissionGroups(this.rows(), this.toolSummaries()));

  /** True when the transcript already includes at least one user-authored row. */
  readonly hasUserMessage = computed(() =>
    this.rows().some((row) => row.type === 'message' && row.kind === 'user'),
  );

  /** Id of the assistant row currently streaming, for the caret. */
  readonly streamingId = computed<string | null>(() => {
    if (!this.isRunning()) return null;
    const rows = this.rows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.type === 'message' && row.kind === 'assistant') return row.id;
      if (row.type === 'message' && row.kind === 'user') return null;
    }
    return null;
  });

  private connectedSessionId: number | null = null;
  private connectedProvider: AgentProviderId | null = null;
  private stickToBottom = true;
  private runStartedAt = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const sessionId = this.mission().sessionId;
      this.connect(sessionId);
    });

    // Keep pinned to newest content while the user is at the bottom.
    effect(() => {
      this.rows();
      this.isRunning();
      this.pendingPermission();
      this.pendingUserInput();
      if (!this.stickToBottom) return;
      const el = this.scrollRef()?.nativeElement;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });

    effect(() => {
      this.draft();
      requestAnimationFrame(() => this.autoGrow());
    });

    // Tick the "working for…" label while the agent runs.
    effect(() => {
      const running = this.isRunning();
      if (running) {
        if (!this.runStartedAt) this.runStartedAt = Date.now();
        this.tickElapsed();
        if (!this.elapsedTimer) {
          this.elapsedTimer = setInterval(() => this.tickElapsed(), 1000);
        }
      } else {
        this.runStartedAt = 0;
        this.elapsedLabel.set('');
        this.clearElapsedTimer();
      }
    });

    this.destroyRef.onDestroy(() => {
      this.disconnect();
      this.clearElapsedTimer();
    });
  }

  // --- composer + scroll ----------------------------------------------------

  autoGrow(): void {
    const el = this.composerRef()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  onScroll(): void {
    const el = this.scrollRef()?.nativeElement;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.stickToBottom = distance < 64;
    this.atBottom.set(this.stickToBottom);
  }

  jumpToLatest(): void {
    const el = this.scrollRef()?.nativeElement;
    if (!el) return;
    this.stickToBottom = true;
    this.atBottom.set(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  onComposeKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit();
    }
  }

  toggleExpand(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  toggleCluster(id: string): void {
    this.expandedClusters.update((set) => {
      const next = new Set(set);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  /**
   * True for any cluster that contains items currently in `liveItems` — i.e.
   * every cluster that belongs to the agent's current run. While the agent is
   * running all such clusters stay expanded so individual tool calls remain
   * visible; they collapse to pills only after the run completes.
   */
  isLiveCluster(group: ClusterGroup): boolean {
    if (!this.isRunning()) return false;
    const liveIds = new Set(this.liveItems().map((item) => item.id));
    return group.rows.some((row) => liveIds.has(row.id));
  }

  /**
   * Whether the user has explicitly expanded this cluster. Liveness is handled
   * separately (see `isLiveCluster`) so that once the run ends, even the last
   * cluster folds back to its pill unless the user opened it.
   */
  isClusterOpen(group: ClusterGroup): boolean {
    return this.expandedClusters().has(group.id);
  }

  // --- actions --------------------------------------------------------------

  submit(): void {
    const prompt = this.draft().trim();
    if (!prompt || this.submitting()) return;

    this.conversation.addOptimisticPrompt(prompt);
    this.stickToBottom = true;
    this.atBottom.set(true);
    this.draft.set('');
    this.submitting.set(true);
    this.lastError.set(null);
    // Report the open session out-of-band (not in the prompt). The agent pulls
    // it on demand via get_focused_session only when the user's words imply the
    // currently-open session, so a follow-up never mis-attributes to it.
    this.send({
      type: 'submit_prompt',
      prompt,
      focusedSessionId: this.tabService.activeTab()?.sessionId ?? null,
    });
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
  }

  approvePermission(approval: ClaudePermissionApproval): void {
    const req = this.pendingPermission();
    if (!req) return;
    this.pendingPermission.set(null);
    this.send({
      type: 'approve_permission',
      requestId: req.requestId,
      remember: approval.remember,
      content: approval.content,
    });
  }

  denyPermission(message?: string): void {
    const req = this.pendingPermission();
    if (!req) return;
    this.pendingPermission.set(null);
    this.send({
      type: 'deny_permission',
      requestId: req.requestId,
      message: message?.trim() || undefined,
    });
  }

  answerUserInput(payload: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }): void {
    const req = this.pendingUserInput();
    if (!req) return;
    this.pendingUserInput.set(null);
    this.send({
      type: 'answer_user_input',
      requestId: req.requestId,
      action: payload.action,
      content: payload.content,
    });
  }

  dismissShow(id: string): void {
    this.shows.dismiss(id);
  }

  openShow(show: AgentShow): void {
    if (show.deepLink) this.channel.openDeepLink(show.deepLink);
  }

  // --- runtime plumbing -----------------------------------------------------

  private connect(sessionId: number): void {
    const provider = this.provider();
    if (this.connectedSessionId === sessionId && this.connectedProvider === provider) return;
    this.disconnect();
    this.resetState();
    this.connectedSessionId = sessionId;
    this.connectedProvider = provider;
    this.runtime.attach({ sessionId, provider }, this.conversation, (event) =>
      this.handleEvent(event),
    );
  }

  private disconnect(): void {
    this.runtime.detach();
    this.connectedSessionId = null;
    this.connectedProvider = null;
  }

  private send(message: Record<string, unknown>): void {
    this.ws.send(this.mission().sessionId, message, this.provider());
  }

  private handleEvent(event: ClaudeRuntimeEvent): void {
    if (event.type === 'tool_summary')
      this.toolSummaries.update((items) => [...items, event.payload.summary]);
    if (
      event.type === 'complete' ||
      event.type === 'error' ||
      (event.type === 'run_state' && event.payload.runPhase !== 'running')
    )
      this.submitting.set(false);
  }

  private resetState(): void {
    this.conversation.reset();
    this.toolSummaries.set([]);
    this.expandedClusters.set(new Set());
    this.submitting.set(false);
    this.stickToBottom = true;
    this.atBottom.set(true);
  }

  private tickElapsed(): void {
    if (!this.runStartedAt) {
      this.elapsedLabel.set('');
      return;
    }
    const seconds = Math.max(0, Math.round((Date.now() - this.runStartedAt) / 1000));
    if (seconds < 60) {
      this.elapsedLabel.set(`${seconds}s`);
    } else {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      this.elapsedLabel.set(`${m}m ${s}s`);
    }
  }

  private clearElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}
