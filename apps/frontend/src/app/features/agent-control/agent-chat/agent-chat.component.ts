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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideBraces,
  lucideCheck,
  lucideChevronDown,
  lucideCircleStop,
  lucideCopy,
  lucideFilePen,
  lucideFilePlus,
  lucideFileText,
  lucideGitBranch,
  lucideGlobe,
  lucideListTodo,
  lucideMap,
  lucidePlugZap,
  lucideSearch,
  lucideSend,
  lucideShieldCheck,
  lucideSparkles,
  lucideTerminal,
  lucideUsers,
  lucideZap,
} from '@ng-icons/lucide';

import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type {
  ClaudePermissionApproval,
  ClaudePermissionRequest,
  ClaudeRunPhase,
  ClaudeRuntimeEvent,
  ClaudeRuntimeState,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '@/shared/models/claude-runtime.model';
import type { Session } from '@/shared/models/session.model';
import {
  contentToString,
  describeAgentTool,
  resultSummary,
  shouldHideToolCall,
} from '@/shared/agent-tools/agent-tool-format';
import { MarkdownPipe } from '@/features/session/claude-workspace/pipes/markdown.pipe';
import { ClaudePermissionInlineComponent } from '@/features/session/claude-workspace/components/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/features/session/claude-workspace/components/claude-user-input.component';

/** The three autonomy modes from ELEVENEX_AGENT.md. */
export type AgentAutonomyMode = 'plan' | 'review' | 'auto';

interface AgentChatRow {
  id: string;
  type: 'message' | 'thinking' | 'activity' | 'error';
  kind: ClaudeTranscriptItem['kind'];
  content: string;
  // Activity rows only:
  icon?: string;
  verb?: string;
  target?: string;
  status?: 'pending' | 'ok' | 'error';
  summary?: string;
  summaryTone?: 'neutral' | 'ok' | 'warn' | 'error';
  detail?: string;
  output?: string;
  timestamp: string;
}

interface AgentSuggestion {
  icon: string;
  label: string;
  prompt: string;
}

/** Cap expandable tool detail/output so a huge diff can't blow up the DOM. */
const DETAIL_CAP = 4000;

function capText(text: string): string {
  return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}\n…` : text;
}

function formatToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input : '';
  }
  const record = input as Record<string, unknown>;
  // A bash command reads best as the raw command rather than JSON.
  if (typeof record['command'] === 'string') {
    return capText(record['command'].trim());
  }
  try {
    return capText(JSON.stringify(input, null, 2));
  } catch {
    return '';
  }
}

interface AutonomyOption {
  mode: AgentAutonomyMode;
  label: string;
  icon: string;
  hint: string;
}

@Component({
  selector: 'app-agent-chat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    NgIcon,
    MarkdownPipe,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
  ],
  templateUrl: './agent-chat.component.html',
  styleUrl: './agent-chat.component.scss',
  viewProviders: [
    provideIcons({
      lucideArrowDown,
      lucideBraces,
      lucideCheck,
      lucideChevronDown,
      lucideCircleStop,
      lucideCopy,
      lucideFilePen,
      lucideFilePlus,
      lucideFileText,
      lucideGitBranch,
      lucideGlobe,
      lucideListTodo,
      lucideMap,
      lucidePlugZap,
      lucideSearch,
      lucideSend,
      lucideShieldCheck,
      lucideSparkles,
      lucideTerminal,
      lucideUsers,
      lucideZap,
    }),
  ],
})
export class AgentChatComponent {
  readonly session = input.required<Session>();

  private readonly messagesRef = viewChild<ElementRef<HTMLElement>>('messagesRef');
  private readonly composerRef =
    viewChild<ElementRef<HTMLTextAreaElement>>('composerRef');

  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly api = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly autonomyOptions: AutonomyOption[] = [
    {
      mode: 'plan',
      label: 'Plan',
      icon: 'lucideMap',
      hint: 'Read-only. Proposes a plan and waits for your approval.',
    },
    {
      mode: 'review',
      label: 'Review',
      icon: 'lucideShieldCheck',
      hint: 'Runs freely but asks before destructive actions (push, PRs, resets).',
    },
    {
      mode: 'auto',
      label: 'Auto',
      icon: 'lucideZap',
      hint: 'Full autonomy — runs end to end without stopping for approvals.',
    },
  ];

  readonly suggestions: AgentSuggestion[] = [
    {
      icon: 'lucideListTodo',
      label: 'Plan a task',
      prompt: 'Help me plan a change before writing any code.',
    },
    {
      icon: 'lucideSearch',
      label: 'Tour the codebase',
      prompt: 'Give me a high-level tour of this codebase.',
    },
    {
      icon: 'lucideGitBranch',
      label: 'Review my changes',
      prompt: 'Review my current uncommitted changes and suggest improvements.',
    },
    {
      icon: 'lucideZap',
      label: 'Fix failing tests',
      prompt: 'Find the failing tests and fix them.',
    },
  ];

  readonly draft = signal('');
  readonly autonomyMode = signal<AgentAutonomyMode>('review');
  readonly modeMenuOpen = signal(false);
  readonly expandedRows = signal<ReadonlySet<string>>(new Set());
  readonly copiedId = signal<string | null>(null);
  readonly showJumpToLatest = signal(false);
  readonly historyItems = signal<ClaudeTranscriptItem[]>([]);
  readonly liveItems = signal<ClaudeTranscriptItem[]>([]);
  readonly optimisticUserItems = signal<ClaudeTranscriptItem[]>([]);
  readonly runPhase = signal<ClaudeRunPhase>('idle');
  readonly canInterrupt = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly pendingPermission = signal<ClaudePermissionRequest | null>(null);
  readonly pendingUserInput = signal<ClaudeUserInputRequest | null>(null);

  readonly isRunning = computed(
    () => this.runPhase() === 'running' || this.submitting(),
  );

  /**
   * The condensed transcript. Messages render as bubbles, tool calls collapse to
   * single activity lines, thinking shows subtly, and noisy bookkeeping tools are
   * dropped entirely — this is what differentiates the agent panel from the full
   * session UI.
   */
  readonly rows = computed<AgentChatRow[]>(() => {
    const history = this.historyItems();
    const persistedKeys = new Set(
      history
        .filter((item) => item.sourceMessageId)
        .map((item) => `${item.sourceMessageId}|${item.kind}`),
    );
    const live = this.liveItems().filter(
      (item) =>
        !item.sourceMessageId ||
        !persistedKeys.has(`${item.sourceMessageId}|${item.kind}`),
    );

    const items = [...history, ...this.optimisticUserItems(), ...live].sort(
      (a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''),
    );

    // tool_use status is derived from its matching tool_result, then results are
    // dropped from the visible stream (folded into the activity line).
    const resultByToolUse = new Map<string, ClaudeTranscriptItem>();
    for (const item of items) {
      if (item.kind === 'tool_result' && item.toolUseId) {
        resultByToolUse.set(item.toolUseId, item);
      }
    }

    const rows: AgentChatRow[] = [];
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
            kind: item.kind,
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
          const result = item.toolUseId
            ? resultByToolUse.get(item.toolUseId)
            : undefined;
          const status: AgentChatRow['status'] = !result
            ? 'pending'
            : result.isError
              ? 'error'
              : 'ok';
          const summary = result
            ? resultSummary(
                view.kind,
                { content: result.content, isError: result.isError },
                item.interaction,
              )
            : null;
          const detail = formatToolInput(item.toolInput);
          const output = result ? capText(contentToString(result.content).trim()) : '';
          rows.push({
            id: item.id,
            type: 'activity',
            kind: item.kind,
            content: '',
            icon: view.icon,
            verb: view.verb,
            target: view.target,
            status,
            summary: summary?.text || undefined,
            summaryTone: summary?.tone,
            detail: detail || undefined,
            output: output || undefined,
            timestamp: item.timestamp,
          });
          break;
        }
        default:
          break;
      }
    }
    return rows;
  });

  readonly activeOption = computed(
    () =>
      this.autonomyOptions.find((o) => o.mode === this.autonomyMode()) ??
      this.autonomyOptions[1],
  );

  /** The id of the assistant message currently streaming, for the typing caret. */
  readonly streamingId = computed<string | null>(() => {
    if (this.runPhase() !== 'running') return null;
    const live = this.liveItems();
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].kind === 'assistant') return live[i].id;
    }
    return null;
  });

  private connectedSessionId: number | null = null;
  private connectedProvider: AgentProviderId | null = null;
  private modeApplied = false;
  private stickToBottom = true;

  constructor() {
    // (Re)connect whenever the bound session changes.
    effect(() => {
      const session = this.session();
      this.connect(session.id, session.activeAgentProvider as AgentProviderId);
    });

    // Keep pinned to the newest content while the user is at the bottom.
    effect(() => {
      this.rows();
      this.isRunning();
      this.pendingPermission();
      this.pendingUserInput();
      if (!this.stickToBottom) return;
      const el = this.messagesRef()?.nativeElement;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });

    effect(() => {
      this.draft();
      requestAnimationFrame(() => this.autoGrow());
    });

    this.destroyRef.onDestroy(() => this.disconnect());
  }

  provider(): AgentProviderId {
    return this.session().activeAgentProvider as AgentProviderId;
  }

  autoGrow(): void {
    const el = this.composerRef()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  onMessagesScroll(): void {
    const el = this.messagesRef()?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.stickToBottom = distanceFromBottom < 56;
    this.showJumpToLatest.set(distanceFromBottom > 120);
  }

  scrollToBottom(): void {
    const el = this.messagesRef()?.nativeElement;
    if (!el) return;
    this.stickToBottom = true;
    this.showJumpToLatest.set(false);
    el.scrollTop = el.scrollHeight;
  }

  toggleExpand(id: string): void {
    this.expandedRows.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  isExpanded(id: string): boolean {
    return this.expandedRows().has(id);
  }

  toggleModeMenu(): void {
    this.modeMenuOpen.update((open) => !open);
  }

  async useSuggestion(suggestion: AgentSuggestion): Promise<void> {
    this.draft.set(suggestion.prompt);
    await this.submit();
  }

  async copyMessage(row: AgentChatRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(row.content);
      this.copiedId.set(row.id);
      setTimeout(() => {
        if (this.copiedId() === row.id) this.copiedId.set(null);
      }, 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — nothing actionable.
    }
  }

  onComposeKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.submit();
    }
  }

  async submit(): Promise<void> {
    const prompt = this.draft().trim();
    if (!prompt || this.submitting()) return;

    await this.ensureModeApplied();

    const now = new Date().toISOString();
    this.optimisticUserItems.update((items) => [
      ...items,
      { id: `opt-${now}`, kind: 'user', content: prompt, timestamp: now },
    ]);
    this.stickToBottom = true;
    this.draft.set('');
    this.submitting.set(true);
    this.lastError.set(null);

    this.send({ type: 'submit_prompt', prompt, titlePrompt: prompt });
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
  }

  async setMode(mode: AgentAutonomyMode): Promise<void> {
    this.modeMenuOpen.set(false);
    if (mode === this.autonomyMode()) return;
    this.autonomyMode.set(mode);
    this.modeApplied = false;
    await this.applyMode(mode);
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

  // --- runtime plumbing -----------------------------------------------------

  private connect(sessionId: number, provider: AgentProviderId): void {
    if (
      this.connectedSessionId === sessionId &&
      this.connectedProvider === provider
    ) {
      return;
    }
    this.disconnect();
    this.resetState();
    this.connectedSessionId = sessionId;
    this.connectedProvider = provider;
    this.ws
      .connect(sessionId, provider)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleEvent(event as ClaudeRuntimeEvent));
    this.ws.send(sessionId, { type: 'hydrate' }, provider);
  }

  private disconnect(): void {
    if (this.connectedSessionId !== null && this.connectedProvider) {
      this.ws.disconnect(this.connectedSessionId, this.connectedProvider);
    }
    this.connectedSessionId = null;
    this.connectedProvider = null;
  }

  private send(message: Record<string, unknown>): void {
    const session = this.session();
    this.ws.send(session.id, message, this.provider());
  }

  private handleEvent(event: ClaudeRuntimeEvent): void {
    switch (event.type) {
      case 'session_snapshot':
        this.historyItems.set(event.payload.history ?? []);
        this.reconcileOptimistic(event.payload.history ?? []);
        this.applyRuntimeState(event.payload);
        return;
      case 'runtime_snapshot':
        this.applyRuntimeState(event.payload);
        return;
      case 'history_snapshot':
        this.historyItems.set(event.payload.history ?? []);
        this.reconcileOptimistic(event.payload.history ?? []);
        return;
      case 'run_state':
        this.runPhase.set(event.payload.runPhase);
        this.canInterrupt.set(event.payload.canInterrupt);
        this.lastError.set(event.payload.lastError);
        this.pendingPermission.set(event.payload.pendingPermissionRequest);
        this.pendingUserInput.set(event.payload.pendingUserInputRequest);
        this.syncMode(event.payload.planMode, event.payload.permissionMode);
        if (event.payload.runPhase !== 'running') this.submitting.set(false);
        return;
      case 'message_start':
      case 'thinking_start':
      case 'tool_use':
      case 'tool_result':
        this.upsertLiveItem(event.payload.item);
        return;
      case 'message_delta':
      case 'thinking_delta':
        this.appendDelta(event.payload.itemId, event.payload.delta);
        return;
      case 'permission_request':
        this.pendingPermission.set(event.payload.request);
        return;
      case 'permission_resolved':
        if (this.pendingPermission()?.requestId === event.payload.requestId) {
          this.pendingPermission.set(null);
        }
        return;
      case 'user_input_request':
        this.pendingUserInput.set(event.payload.request);
        return;
      case 'error':
        this.lastError.set(event.payload.message);
        this.submitting.set(false);
        return;
      case 'complete':
        this.runPhase.set('idle');
        this.canInterrupt.set(false);
        this.submitting.set(false);
        void this.refreshHistory();
        return;
      default:
        return;
    }
  }

  private applyRuntimeState(state: ClaudeRuntimeState): void {
    this.liveItems.set(state.liveItems ?? []);
    this.runPhase.set(state.runPhase ?? 'idle');
    this.canInterrupt.set(Boolean(state.canInterrupt));
    this.lastError.set(state.lastError ?? null);
    this.pendingPermission.set(state.pendingPermissionRequest ?? null);
    this.pendingUserInput.set(state.pendingUserInputRequest ?? null);
    this.syncMode(state.planMode, state.permissionMode);
    if (state.runPhase !== 'running') this.submitting.set(false);
  }

  private syncMode(
    planMode: boolean,
    permissionMode: ClaudeRuntimeState['permissionMode'],
  ): void {
    // Reflect the backend's actual mode in the selector.
    const resolved: AgentAutonomyMode = planMode
      ? 'plan'
      : permissionMode === 'bypassPermissions'
        ? 'auto'
        : 'review';
    this.autonomyMode.set(resolved);

    // Only treat the mode as applied when the backend already holds the canonical
    // mapping. A fresh session reports plain `default`, which buckets to "Review"
    // but isn't yet `acceptEdits` — leave it unapplied so the first submit pushes
    // acceptEdits and edits flow freely while destructive actions still escalate.
    this.modeApplied =
      resolved === 'plan'
        ? planMode
        : resolved === 'auto'
          ? permissionMode === 'bypassPermissions'
          : permissionMode === 'acceptEdits';
  }

  private async ensureModeApplied(): Promise<void> {
    if (this.modeApplied) return;
    await this.applyMode(this.autonomyMode());
  }

  private async applyMode(mode: AgentAutonomyMode): Promise<void> {
    const session = this.session();
    const provider = this.provider();
    try {
      if (mode === 'plan') {
        await firstValueFrom(this.api.setPlanMode(session.id, true, provider));
      } else {
        await firstValueFrom(this.api.setPlanMode(session.id, false, provider));
        await firstValueFrom(
          this.api.setPermissionMode(
            session.id,
            mode === 'auto' ? 'bypassPermissions' : 'acceptEdits',
            provider,
          ),
        );
      }
      this.modeApplied = true;
    } catch {
      // Leave modeApplied false so the next submit retries the mode.
    }
  }

  private upsertLiveItem(item: ClaudeTranscriptItem): void {
    this.liveItems.update((items) => [
      ...items.filter((existing) => existing.id !== item.id),
      item,
    ]);
  }

  private appendDelta(itemId: string, delta: string): void {
    this.liveItems.update((items) =>
      items.map((item) =>
        item.id === itemId
          ? { ...item, content: `${item.content ?? ''}${delta}` }
          : item,
      ),
    );
  }

  private async refreshHistory(): Promise<void> {
    const session = this.session();
    const provider = this.provider();
    try {
      const history = (await firstValueFrom(
        this.api.getHistory(session.id, provider),
      )) as ClaudeTranscriptItem[];
      this.historyItems.set(history);
      this.reconcileOptimistic(history);
      const persistedKeys = new Set(
        history
          .filter((item) => item.sourceMessageId)
          .map((item) => `${item.sourceMessageId}|${item.kind}`),
      );
      this.liveItems.update((items) =>
        items.filter(
          (item) =>
            !item.sourceMessageId ||
            !persistedKeys.has(`${item.sourceMessageId}|${item.kind}`),
        ),
      );
    } catch {
      // Keep the streamed live items if the history refresh fails.
    }
  }

  private reconcileOptimistic(history: ClaudeTranscriptItem[]): void {
    const seen = new Set(
      history
        .filter((item) => item.kind === 'user')
        .map((item) => (item.content ?? '').trim()),
    );
    this.optimisticUserItems.update((items) =>
      items.filter((item) => !seen.has((item.content ?? '').trim())),
    );
  }

  private resetState(): void {
    this.historyItems.set([]);
    this.liveItems.set([]);
    this.optimisticUserItems.set([]);
    this.runPhase.set('idle');
    this.canInterrupt.set(false);
    this.lastError.set(null);
    this.submitting.set(false);
    this.pendingPermission.set(null);
    this.pendingUserInput.set(null);
    this.modeApplied = false;
    this.stickToBottom = true;
  }
}
