import { OpensWhenBackComponent } from '../machines';
import { SessionChatAttachments } from './session-chat-attachments';
import { SessionChatMedia } from './session-chat-media';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import {
  ApprovalCardComponent,
  AgentUsageNoticeComponent,
  ChatComponent,
  ComposerComponent,
  QuestionCardComponent,
  PresetPickerComponent,
  PresetCreatorComponent,
  ToolContentComponent,
  type AgentQuestion,
  type QuestionAnswers,
  type TurnAction,
  type AgentConfig,
  type AgentHarness,
  type AgentModel,
  type PermissionChoice,
  type ConversationMention,
  type ToolContentRequest,
  type ToolContentSource,
} from "../conversation";
import {
  AutoHeightDirective,
  ButtonComponent,
  ContextMeterComponent,
  IconComponent,
  DropdownComponent,
  PresenceComponent,
  ToastComponent,
  SkeletonComponent,
  StatusGlyphComponent,
} from "../ui";
import type { StartingSession } from './session-chat-drafts';
import { SessionChatStore, type ChatSelection } from "./session-chat.store";
import { SessionChatContentComponent } from "./session-chat-content.component";
import { SessionAgentComponent } from './session-agent.component';
import { SessionActivityComponent } from "./session-activity.component";
import { SessionChatPresets } from "./session-chat-presets";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { sessionPlanUsage } from "./session-chat-usage";
import { presentSessionTool } from './session-chat-tools';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';

const copyFailureMessage = 'Could not copy. Select the text and copy it manually.';

@Component({
  selector: "ex-session-chat",
  providers: [SessionChatStore, SessionChatMedia, SessionChatAttachments],
  imports: [
    AutoHeightDirective,
    OpensWhenBackComponent,
    SessionChatContentComponent,
    SessionActivityComponent,
    SessionAgentComponent,
    ChatComponent,
    ComposerComponent,
    ApprovalCardComponent,
    AgentUsageNoticeComponent,
    QuestionCardComponent,
    PresetPickerComponent,
    PresetCreatorComponent,
    ToolContentComponent,
    ButtonComponent,
    ContextMeterComponent,
    StatusGlyphComponent,
    SkeletonComponent,
    IconComponent,
    DropdownComponent,
    PresenceComponent,
    ToastComponent,
  ],
  templateUrl: "./session-chat.component.html",
  styleUrl: "./session-chat.component.css",
  host: {
    "(keydown)": "presetFlow.presetShortcut($event)",
    "(dragover)": "dragOver($event)",
    "(drop)": "dropFiles($event)",
    "(dragleave)": "composer()?.dragLeave($event)",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionChatComponent {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private copyRevision = 0;
  openToolContent(request: ToolContentRequest): void {
    const items = this.store.items();
    const item = items.find(item => item.id === request.itemId);
    const toolId = item?.toolId ?? item?.id;
    this.contentSource.set(item?.kind === 'tool_use' || item?.kind === 'tool_result' ? {
      inputId: item.kind === 'tool_use' ? item.id : items.find(value => value.kind === 'tool_use' && (value.toolId ?? value.id) === toolId)?.id,
      outputId: item.kind === 'tool_result' ? item.id : [...items].reverse().find(value => value.kind === 'tool_result' && value.toolId === toolId)?.id,
    } : undefined);
    this.contentPart.set(request.part);
    this.contentId.set(request.itemId);
  }
  readonly selection = input<ChatSelection | null>(null);
  readonly creation = input<StartingSession | null>(null);
  /** Stable through a create receipt, including one that arrives before first paint. */
  readonly creationKey = input<string | null>(null);
  readonly creationRetry = output<void>();
  readonly creationCheck = output<void>();
  readonly creationDiscard = output<void>();
  readonly archived = input(false);
  readonly active = input(true);
  readonly machineName = input('the machine');
  readonly reconnectAction = input('Try now');
  readonly outageSince = input<number | null>(null);
  readonly reconnectRequested = output<void>();
  readonly mentionItems = input<readonly ConversationMention[]>([]);
  readonly reviewRequested = output<ChatSelection & { readonly turnId: string; readonly path?: string }>();
  readonly store = inject(SessionChatStore);
  readonly media = inject(SessionChatMedia);
  readonly attachments = inject(SessionChatAttachments);
  readonly permissionEvidence = computed(() => {
    const request = this.store.state()?.permission;
    return request ? presentSessionTool({
      id: request.id, kind: 'tool_use', timestamp: '', text: '',
      toolId: null, toolKind: null, toolName: request.title,
      input: request.input, error: false, truncated: false,
    }) : null;
  });
  readonly composer = viewChild(ComposerComponent);
  readonly chat = viewChild(ChatComponent);
  readonly requestElement = viewChild<unknown, ElementRef<HTMLElement>>(
    "request",
    {
      read: ElementRef,
    },
  );
  readonly message = computed(
    () => this.store.error() || this.store.state()?.error || "",
  );
  readonly copiedCode = signal<string | null>(null);
  readonly agentId = signal<string | null>(null);
  /** The inspected agent's live Activity record, while it is still listed. */
  readonly agentWork = computed(() => {
    const id = this.agentId();
    return (
      this.store.state()?.work?.running.find((item) => item.agentId === id) ??
      null
    );
  });
  readonly contentId = signal<string | null>(null);
  readonly contentSource = signal<ToolContentSource | undefined>(undefined);
  readonly contentPart = signal<'input' | 'text'>('text');
  readonly identity = computed(
    () =>
      this.creationKey() ?? this.creation()?.id ?? `${this.selection()?.scopeId}:${this.selection()?.taskId}:${this.selection()?.sessionId}`,
  );
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly usageTime = signal(Date.now());
  /** Work outliving its turn keeps the session busy even after the reply ends. */
  readonly background = computed(
    () => !!this.store.state()?.work?.running.some(item => item.background !== false),
  );
  readonly status = computed(() =>
    this.store.state()?.permission || this.store.state()?.question
      ? "attention"
      : this.store.running() || this.background()
        ? "running"
        : this.store.state()?.phase === "error"
          ? "failed"
          : "done",
  );
  readonly statusLabel = computed(() =>
    this.status() === "attention"
      ? "Needs you"
      : this.status() === "running"
        ? this.store.running()
          ? "Running"
          : "Working in background"
        : this.status() === "failed"
          ? "Failed"
          : "Ready",
  );
  readonly blocked = computed(
    () =>
      (this.store.offline() && !this.store.outbox) ||
      !!this.store.busy() ||
      !!this.store.uncertain() ||
      this.archived() ||
      !this.store.state(),
  );
  readonly activityDisabledReason = computed(() => this.archived() ? 'This session is archived. Activity is read only.'
    : this.store.offline() ? 'Reconnect to control this work.'
    : this.store.historical() ? 'Return to latest to control this work.'
    : this.store.uncertain() ? 'Check the previous action’s outcome before another action.'
    : this.store.busy() ? 'An action is in progress.' : '');
  readonly models = computed<readonly AgentModel[]>(() =>
    (this.store.state()?.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      thinking: model.reasoningEfforts ?? [],
      supportsFastMode: model.supportsFastMode,
    })),
  );
  readonly providers = computed(() => this.store.state()?.providers ?? []);
  readonly harnesses = computed<readonly AgentHarness[]>(() => {
    const state = this.store.state();
    if (!state) return [];
    const providers = this.providers().length
      ? this.providers()
      : [{ id: state.provider, label: this.providerLabel() }];
    return providers.map((provider) => ({
      ...provider,
      mark:
        (
          { claude: "Cl", codex: "Cx", pi: "Pi", opencode: "Oc" } as Readonly<
            Record<string, string>
          >
        )[provider.id] ?? provider.label.slice(0, 2),
      models: provider.id === state.provider ? this.models() : [],
    }));
  });
  readonly showWelcome = computed(
    () =>
      !this.archived() &&
      (this.store.starting() || !!this.store.state()) &&
      this.store.empty() &&
      !this.store.historical() &&
      !this.store.state()?.providerLocked &&
      !this.store.state()?.permission &&
      !this.store.state()?.question,
  );
  readonly presetFlow: SessionChatPresets = new SessionChatPresets({
    store: this.store,
    client: inject(SessionChatClient),
    selection: this.selection,
    identity: this.identity,
    harnesses: this.harnesses,
    models: this.models,
    blocked: this.blocked,
    showWelcome: this.showWelcome,
    agent: (): AgentConfig | undefined => this.agent(),
    focusComposer: () => this.focusComposer(),
    closeAgent: () => this.composer()?.agentPicker()?.closePicker(),
  });
  readonly agent = computed<AgentConfig | undefined>(() => {
    const state = this.store.state();
    if (!state) return undefined;
    return {
      preset: this.presetFlow.selectedPreset()?.preset,
      harnessLabel: this.providerLabel(),
      harness: state.provider,
      mark:
        this.harnesses().find((harness) => harness.id === state.provider)
          ?.mark ?? "Ag",
      model: state.model ?? "",
      thinking: state.reasoning ?? undefined,
      fast: state.fast,
      context: state.context ? state.context.percentage / 100 : undefined,
      tokens: state.context
        ? `${this.tokenNumber.format(state.context.tokens).toLowerCase()} of ${this.tokenNumber.format(state.context.limit).toLowerCase()}`
        : undefined,
      plan: sessionPlanUsage(state.planUsage, this.usageTime()),
    };
  });
  readonly fastAvailable = computed(() => {
    const state = this.store.state();
    return (
      !!state?.controls?.fast &&
      (state.fast === true ||
        state.models.find((model) => model.id === state.model)
          ?.supportsFastMode === true)
    );
  });
  private readonly tokenNumber = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 0,
  });
  agentChanged(value: AgentConfig): void {
    const current = this.agent();
    if (
      !current ||
      this.blocked() ||
      this.store.historical() ||
      this.store.loading()
    )
      return;
    if (value.harness !== current.harness)
      void this.chooseProvider(value.harness);
    else if (value.model !== current.model)
      void this.store.perform({ type: "model", model: value.model || null });
    else if (value.thinking !== current.thinking)
      void this.store.perform({
        type: "reasoning",
        effort: value.thinking || null,
      });
    else if (value.fast !== current.fast)
      void this.store.perform({ type: "fast", enabled: !!value.fast });
  }
  readonly providerLabel = computed(
    () =>
      this.providers().find(
        (provider) => provider.id === this.store.state()?.provider,
      )?.label ??
      this.store.state()?.provider ??
      "Agent",
  );
  async chooseProvider(provider: string): Promise<void> {
    const current = this.store.state()?.provider;
    if (current && provider !== current) {
      await this.store.perform({
        type: "provider",
        provider,
        expectedProvider: current,
      });
    }
  }
  readonly permissions = computed<readonly PermissionChoice[]>(() =>
    (this.store.state()?.permissionModes ?? []).map((id) => ({
      id,
      detail:
        (
          {
            default: "Ask before the agent takes protected actions",
            acceptEdits: "Apply edits; ask before commands",
            bypassPermissions: "Allow actions without permission prompts",
            auto: "Use the harness’s automatic permission policy",
            plan: "Read and propose before making changes",
            dontAsk: "Deny actions that need permission",
          } as Readonly<Record<string, string>>
        )[id] ?? "Use this harness permission policy",
      label:
        (
          {
            default: "Ask first",
            acceptEdits: "Auto-edit",
            bypassPermissions: "Full auto",
            auto: "Auto",
            plan: "Plan",
            dontAsk: "Do not ask",
          } as Readonly<Record<string, string>>
        )[id] ?? id,
    })),
  );
  readonly questions = computed<readonly AgentQuestion[]>(() =>
    (this.store.state()?.question?.questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      kind: q.multiple ? "multi" : "single",
      options: q.options.map((o) => ({ label: o.label, detail: o.detail })),
    })),
  );

  dragOver(event: DragEvent): void {
    if (!event.defaultPrevented && event.dataTransfer?.types.includes('Files') && this.store.state()?.attachments) this.composer()?.dragOver(event);
  }
  dropFiles(event: DragEvent): void {
    if (!event.defaultPrevented && event.dataTransfer?.types.includes('Files') && this.store.state()?.attachments) this.composer()?.drop(event);
  }
  constructor() {
    effect(() => {
      const selection = this.selection();
      this.store.setActive(this.active());
      const creation = this.creation();
      if (creation) this.store.openDraft(creation);
      else if (selection) this.store.open(selection, this.archived());
      untracked(() => this.attachments.open(creation ? null : selection));
      this.media.update(creation ? null : selection, this.store.items());
    });
    effect(() => {
      this.identity();
      this.presetFlow.reset();
      this.copyRevision++;
      clearTimeout(this.copyTimer);
      this.copiedCode.set(null);
    });
    effect(() => { this.store.viewRevision(); this.contentId.set(null); this.agentId.set(null); });
    let focusedDraft: string | null = null;
    afterRenderEffect(() => {
      const key = this.creationKey() ?? this.creation()?.id;
      if (!key) { focusedDraft = null; return; }
      if (this.active() && focusedDraft !== key && this.composer()) {
        focusedDraft = key;
        untracked(() => this.focusComposer());
      }
    });
    let scrollIdentity = -1;
    let opening = true;
    afterRenderEffect(() => {
      const identity = this.store.viewRevision();
      if (identity !== scrollIdentity) {
        scrollIdentity = identity;
        opening = true;
      }
      const ready = !this.store.loading() && !!this.store.state();
      const scroll = this.chat()?.scroll();
      if (!opening || !ready || !scroll) return;
      opening = false;
      // Hydrated history must be positioned before paint, without scroll animation.
      untracked(() => scroll.scrollToEnd("instant"));
    });
    effect((cleanup) => {
      if (!this.store.state()?.planUsage) return;
      this.usageTime.set(Date.now());
      const timer = setInterval(() => this.usageTime.set(Date.now()), 30_000);
      cleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => {
      this.copyRevision++;
      clearTimeout(this.copyTimer);
      this.presetFlow.dispose();
    });
  }
  focusDecision(): void {
    this.chat()?.scroll()?.scrollToEnd();
    this.requestElement()?.nativeElement.focus({ preventScroll: true });
  }
  focusComposer(): void {
    this.composer()?.textarea()?.nativeElement.focus();
  }
  queueAction(type: "steer-queued" | "cancel-queued", id: string): void {
    this.focusComposer();
    void this.store.perform({ type, id });
  }
  continue(): void {
    this.store.setDraft("Please continue.");
    this.focusComposer();
  }
  answer(answers: QuestionAnswers): void {
    const request = this.store.state()?.question;
    if (request)
      void this.store.perform({ type: "answer", id: request.id, answers });
  }
  async copy(text: string, code = false): Promise<void> {
    const revision = ++this.copyRevision;
    const identity = this.identity();
    try {
      await this.bridge.writeClipboardText(text);
      if (revision !== this.copyRevision || identity !== this.identity()) return;
      if (this.store.error() === copyFailureMessage) this.store.error.set('');
      this.store.notice.set("Copied");
      if (code) {
        clearTimeout(this.copyTimer);
        this.copiedCode.set(text);
        this.copyTimer = setTimeout(() => this.copiedCode.set(null), 2000);
      }
    } catch {
      if (revision !== this.copyRevision || identity !== this.identity()) return;
      this.store.error.set(copyFailureMessage);
    }
  }
  turnAction(intent: {
    readonly id: string;
    readonly action: TurnAction;
  }): void {
    if (intent.action === "copy")
      void this.copy(
        this.store.exchanges().find((exchange) => exchange.id === intent.id)
          ?.answer ?? "",
      );
  }
  openLink(value: string): void {
    try {
      const url = new URL(value);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      )
        window.open(url.href, "_blank", "noopener,noreferrer");
    } catch {
      this.store.error.set("This link could not be opened.");
    }
  }
  review(turnId: string, path?: string): void {
    const selection = this.selection();
    if (selection) this.reviewRequested.emit({ ...selection, turnId, ...(path ? { path } : {}) });
  }
  openFile(path: string): void {
    this.store.notice.set(path);
    const turn = this.store.exchanges().filter(exchange => exchange.files?.some(file => file.path === path)).at(-1) ?? this.store.exchanges().at(-1);
    if (turn) this.review(turn.id, path);
  }
}
