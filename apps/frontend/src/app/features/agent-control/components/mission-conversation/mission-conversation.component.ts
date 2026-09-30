import { AgentChatConnection } from '@/shared/agent-chat/agent-chat-connection';
import { AgentConversation } from '@/shared/agent-chat/agent-conversation';
import { AgentMarkdownComponent } from '@/shared/agent-chat/markdown/agent-markdown.component';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
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

import { TabService } from '@/features/session/tab-service';
import { ClaudePermissionInlineComponent } from '@/shared/agent-chat/requests/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/shared/agent-chat/requests/claude-user-input.component';
import {
  contentToString,
  describeAgentTool,
  resultSummary,
  shouldHideToolCall,
  type ResultSummary,
} from '@/shared/agent-tools/agent-tool-format';
import type { AgentShow } from '@/shared/models/agent-channel.model';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type {
  ClaudePermissionApproval,
  ClaudeRuntimeEvent,
  ClaudeToolUseSummary,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentShowsService } from '@/shared/services/agent-shows.service';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import { AgentChannelWebsocketService } from '../../agent-channel-websocket.service';
import type { MissionSummary } from '../../agent-control.model';

/** The four families of elevenex actions, used to tint timeline nodes. */
type ActionCategory = 'observe' | 'setup' | 'drive' | 'communicate' | 'work';

/** Per-elevenex-tool icon + category so each action reads as a product move. */
const ELEVENEX_ACTIONS: Record<string, { icon: string; category: ActionCategory }> = {
  // Observe
  project_overview: { icon: 'lucideLayoutDashboard', category: 'observe' },
  find_sessions: { icon: 'lucideSearch', category: 'observe' },
  session_status: { icon: 'lucideActivity', category: 'observe' },
  read_session: { icon: 'lucideScrollText', category: 'observe' },
  text_search: { icon: 'lucideSearch', category: 'observe' },
  file_search: { icon: 'lucideSearch', category: 'observe' },
  read_file: { icon: 'lucideFileText', category: 'observe' },
  change_review: { icon: 'lucideGitCompare', category: 'observe' },
  get_worktree_context: { icon: 'lucideInfo', category: 'observe' },
  await_session_event: { icon: 'lucideClock', category: 'observe' },
  assess_worktree_pool: { icon: 'lucideLayers', category: 'observe' },
  // Setup
  find_or_create_project: { icon: 'lucideFolderPlus', category: 'setup' },
  add_repo: { icon: 'lucideGitFork', category: 'setup' },
  remove_repo: { icon: 'lucideFolderMinus', category: 'setup' },
  create_worktree: { icon: 'lucideGitBranch', category: 'setup' },
  get_worktree_job: { icon: 'lucideClock', category: 'setup' },
  link_worktree: { icon: 'lucideLink', category: 'setup' },
  steal_worktree: { icon: 'lucideGitBranch', category: 'setup' },
  switch_branch: { icon: 'lucideGitBranch', category: 'setup' },
  generate_worktree_context: { icon: 'lucideFileText', category: 'setup' },
  create_session: { icon: 'lucideTerminal', category: 'setup' },
  set_todo: { icon: 'lucideListChecks', category: 'setup' },
  set_scratchpad: { icon: 'lucidePencil', category: 'setup' },
  // Drive
  prompt_session: { icon: 'lucideSend', category: 'drive' },
  ask_session: { icon: 'lucideMessageCircle', category: 'drive' },
  interrupt_session: { icon: 'lucideSquare', category: 'drive' },
  fork_session: { icon: 'lucideGitFork', category: 'drive' },
  archive_session: { icon: 'lucideArchive', category: 'drive' },
  reset_session: { icon: 'lucideRotateCcw', category: 'drive' },
  get_pending_action: { icon: 'lucideBell', category: 'drive' },
  resolve_action: { icon: 'lucideCheck', category: 'drive' },
  set_provider: { icon: 'lucideCpu', category: 'drive' },
  set_model: { icon: 'lucideCpu', category: 'drive' },
  set_permission_mode: { icon: 'lucideShieldCheck', category: 'drive' },
  // Communicate
  notify_user: { icon: 'lucideBell', category: 'communicate' },
  show_user: { icon: 'lucidePresentation', category: 'communicate' },
  request_approval: { icon: 'lucideShieldCheck', category: 'communicate' },
  escalate_to_user: { icon: 'lucideTriangleAlert', category: 'communicate' },
};

interface ConversationRow {
  id: string;
  type: 'message' | 'thinking' | 'action' | 'error' | 'show';
  kind?: ClaudeTranscriptItem['kind'];
  content?: string;
  // action
  icon?: string;
  verb?: string;
  target?: string;
  category?: ActionCategory;
  status?: 'pending' | 'ok' | 'error';
  result?: ResultSummary | null;
  detail?: string;
  output?: string;
  toolUseId?: string;
  // show
  show?: AgentShow;
  timestamp: string;
}

/**
 * A turn's folded work — tool calls, thinking, and intermediate assistant
 * messages — that collapses to a pill when idle. `actionCount` counts only the
 * tool calls (the "steps"); folded thinking/messages do not add to it.
 */
interface ClusterGroup {
  type: 'cluster';
  id: string;
  rows: ConversationRow[];
  actionCount: number;
  durationLabel: string;
  /** LLM-authored one-liner describing what the agent did, when available. */
  summary: string | null;
}

interface SingleGroup {
  type: 'single';
  id: string;
  row: ConversationRow;
}

type TimelineGroup = ClusterGroup | SingleGroup;

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

  private readonly provider: AgentProviderId = 'claude';

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

  readonly rows = computed<ConversationRow[]>(() => {
    const items = this.conversation.items();

    const resultByToolUse = new Map<string, ClaudeTranscriptItem>();
    for (const item of items) {
      if (item.kind === 'tool_result' && item.toolUseId) {
        resultByToolUse.set(item.toolUseId, item);
      }
    }

    const rows: ConversationRow[] = [];
    for (const item of items) {
      switch (item.kind) {
        case 'user':
        case 'assistant': {
          const content = (item.content ?? '').trim();
          if (!content) break;
          rows.push({
            id: item.id,
            type: 'message',
            kind: item.kind,
            content,
            timestamp: item.timestamp,
          });
          break;
        }
        case 'thinking': {
          const content = (item.content ?? '').trim();
          if (!content) break;
          rows.push({
            id: item.id,
            type: 'thinking',
            kind: item.kind,
            content,
            timestamp: item.timestamp,
          });
          break;
        }
        case 'error': {
          rows.push({
            id: item.id,
            type: 'error',
            content: (item.content ?? 'Something went wrong.').trim(),
            timestamp: item.timestamp,
          });
          break;
        }
        case 'tool_use': {
          if (shouldHideToolCall(item.toolName, item.toolInput, item.toolKind)) {
            break;
          }
          const view = describeAgentTool(item);
          const meta = this.actionMeta(item);
          const result = item.toolUseId ? resultByToolUse.get(item.toolUseId) : undefined;
          const status: ConversationRow['status'] = !result
            ? 'pending'
            : result.isError
              ? 'error'
              : 'ok';
          const output = result ? contentToString(result.content).trim() : '';
          const detail = this.detailFor(item.toolInput);
          rows.push({
            id: item.id,
            type: 'action',
            kind: item.kind,
            icon: meta.icon ?? view.icon,
            verb: view.verb,
            target: view.target,
            category: meta.category,
            status,
            result: result
              ? resultSummary(view.kind, { content: result.content, isError: result.isError })
              : null,
            detail,
            output,
            toolUseId: item.toolUseId,
            timestamp: item.timestamp,
          });
          break;
        }
        default:
          break;
      }
    }

    for (const show of this.missionShows()) {
      rows.push({
        id: `show-${show.id}`,
        type: 'show',
        show,
        timestamp: show.createdAt,
      });
    }

    rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return rows;
  });

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
  readonly groups = computed<TimelineGroup[]>(() => {
    const rows = this.rows();
    const summaries = this.toolSummaries();

    // Pre-mark the last assistant message of each turn so it renders inline as
    // the visible reply while earlier assistant messages fold into the cluster.
    const finalAssistantIds = new Set<string>();
    let lastAssistant: ConversationRow | null = null;
    for (const row of rows) {
      if (row.type === 'message' && row.kind === 'user') {
        if (lastAssistant) finalAssistantIds.add(lastAssistant.id);
        lastAssistant = null;
      } else if (row.type === 'message' && row.kind === 'assistant') {
        lastAssistant = row;
      }
    }
    if (lastAssistant) finalAssistantIds.add(lastAssistant.id);

    const out: TimelineGroup[] = [];
    let cluster: ClusterGroup | null = null;
    const toolIds: string[] = [];

    const flush = () => {
      if (!cluster) return;
      cluster.summary = this.summaryFor(toolIds, summaries);
      cluster.durationLabel = this.spanLabel(
        cluster.rows[0]?.timestamp,
        cluster.rows[cluster.rows.length - 1]?.timestamp,
      );
      out.push(cluster);
      cluster = null;
      toolIds.length = 0;
    };

    for (const row of rows) {
      const isFinalReply =
        row.type === 'message' && row.kind === 'assistant' && finalAssistantIds.has(row.id);
      // Fold the turn's tool calls, thinking, and intermediate assistant
      // messages. Everything else — user prompts, the final reply, shows and
      // errors — stays inline and ends the current cluster.
      const foldable =
        row.type === 'action' ||
        row.type === 'thinking' ||
        (row.type === 'message' && row.kind === 'assistant' && !isFinalReply);

      if (foldable) {
        if (!cluster) {
          cluster = {
            type: 'cluster',
            id: `cluster-${row.id}`,
            rows: [],
            actionCount: 0,
            durationLabel: '',
            summary: null,
          };
        }
        cluster.rows.push(row);
        if (row.type === 'action') {
          cluster.actionCount += 1;
          if (row.toolUseId) toolIds.push(row.toolUseId);
        }
      } else {
        flush();
        out.push({ type: 'single', id: row.id, row });
      }
    }
    flush();
    return out;
  });

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
    if (this.connectedSessionId === sessionId) return;
    this.disconnect();
    this.resetState();
    this.connectedSessionId = sessionId;
    this.runtime.attach({ sessionId, provider: this.provider }, this.conversation, (event) =>
      this.handleEvent(event),
    );
  }

  private disconnect(): void {
    this.runtime.detach();
    this.connectedSessionId = null;
  }

  private send(message: Record<string, unknown>): void {
    this.ws.send(this.mission().sessionId, message, this.provider);
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

  // --- helpers --------------------------------------------------------------

  /** Resolve the elevenex tool name → icon + category, else a neutral "work". */
  private actionMeta(item: ClaudeTranscriptItem): {
    icon: string | null;
    category: ActionCategory;
  } {
    const tool = this.elevenexToolName(item);
    if (tool && ELEVENEX_ACTIONS[tool]) {
      return ELEVENEX_ACTIONS[tool];
    }
    return { icon: null, category: 'work' };
  }

  private elevenexToolName(item: ClaudeTranscriptItem): string | null {
    const raw = item.toolName || item.providerToolName || '';
    const parts = raw.split('__');
    if (parts.length >= 3 && parts[1] === 'elevenex') {
      return parts.slice(2).join('__');
    }
    const data = item.toolInput as Record<string, unknown> | undefined;
    if (data && data['server'] === 'elevenex' && typeof data['tool'] === 'string') {
      return data['tool'];
    }
    return null;
  }

  /** Latest LLM tool-use summary that covers any of the cluster's tool ids. */
  private summaryFor(toolIds: string[], summaries: ClaudeToolUseSummary[]): string | null {
    if (!toolIds.length || !summaries.length) return null;
    const set = new Set(toolIds);
    for (let i = summaries.length - 1; i >= 0; i--) {
      const s = summaries[i];
      if (s.precedingToolUseIds?.some((id) => set.has(id))) {
        return s.summary?.trim() || null;
      }
    }
    return null;
  }

  /** Human label for the elapsed span between two ISO timestamps. */
  private spanLabel(start?: string, end?: string): string {
    if (!start || !end) return '';
    const ms = Date.parse(end) - Date.parse(start);
    if (Number.isNaN(ms) || ms < 1000) return '';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  /** A compact, readable summary of the tool input for the expanded view. */
  private detailFor(input: unknown): string {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
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
