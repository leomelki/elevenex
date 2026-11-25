import { elementMarkersIn, type BrowserElementSnapshot, type DelegatedSessionWork, type SessionAgentReference } from '@elevenex/shared';
import { OpensWhenBackComponent } from '../machines';
import { DOCUMENT } from '@angular/common';
import { SessionChatAttachments } from './session-chat-attachments';
import { SessionChatMedia } from './session-chat-media';
import { SessionChatModels } from './session-chat-models';
import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import {
  ApprovalCardComponent,
  AgentUsageNoticeComponent,
  AgentMarkComponent,
  ChatComponent,
  ChatLoadingComponent,
  ComposerComponent,
  QuestionCardComponent,
  PresetPickerComponent,
  PresetCreatorComponent,
  ToolContentComponent,
  agentIdentity,
  agentControl,
  sessionAgentTitle,
  type AgentWorkIntent,
  type AgentQuestion,
  type ComposerSubmission,
  type QuestionAnswers,
  type TurnAction,
  type AgentConfig,
  type AgentHarness,
  type AgentModel,
  type AgentPlanLimit,
  type PermissionChoice,
  type ConversationMention,
  type ToolContentRequest,
  type ToolContentSource,
} from "../conversation";
import {
  ButtonComponent,
  IconComponent,
  DropdownComponent,
  FoldComponent,
  PresenceComponent,
  ToastComponent,
  StatusGlyphComponent,
  TickerComponent,
} from "../ui";
import type { StartingSession } from './session-chat-drafts';
import { SessionChatStore, type ChatSelection } from "./session-chat.store";
import { SessionChatContentComponent } from "./session-chat-content.component";
import { SessionPromptEditorComponent } from './session-prompt-editor.component';
import { SessionAgentComponent } from './session-agent.component';
import { SessionActivityComponent } from "./session-activity.component";
import { SessionChatPresets } from "./session-chat-presets";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { sessionModelLimits, sessionModelPlan, sessionPlanUsage } from "./session-chat-usage";
import { presentSessionTool } from './session-chat-tools';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { SessionAgentTurnProjection } from './session-agent-turns';

export interface AgentChatFocus {
  readonly selection: ChatSelection;
  readonly action: AgentWorkIntent['action'];
  readonly from: number;
  readonly itemId?: string;
}

const copyFailureMessage = 'Could not copy. Select the text and copy it manually.';

// These bounded, serializable view models can arrive with new IPC identities.
// Activity/token updates must not invalidate unchanged composer configuration.
function equalViewData<T>(left: T, right: T): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
function limitFor(limits: readonly AgentPlanLimit[], model: string): { limit?: AgentPlanLimit } {
  const limit = limits.find((item) => item.id === model);
  return limit ? { limit } : {};
}

@Component({
  selector: "ex-session-chat",
  providers: [SessionChatStore, SessionChatMedia, SessionChatAttachments],
  imports: [
    OpensWhenBackComponent,
    SessionChatContentComponent,
    SessionPromptEditorComponent,
    SessionActivityComponent,
    SessionAgentComponent,
    ChatComponent,
    ChatLoadingComponent,
    ComposerComponent,
    ApprovalCardComponent,
    AgentUsageNoticeComponent,
    AgentMarkComponent,
    QuestionCardComponent,
    PresetPickerComponent,
    PresetCreatorComponent,
    ToolContentComponent,
    ButtonComponent,
    IconComponent,
    DropdownComponent,
    FoldComponent,
    PresenceComponent,
    ToastComponent,
    StatusGlyphComponent,
    TickerComponent,
  ],
  templateUrl: "./session-chat.component.html",
  styleUrl: "./session-chat.component.css",
  host: {
    "(keydown)": "onKey($event)",
    "(dragover)": "dragOver($event)",
    "(drop)": "dropFiles($event)",
    "(dragleave)": "composer()?.dragLeave($event)",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionChatComponent {
  private readonly document = inject(DOCUMENT);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly foreground = signal(this.document.hasFocus() && !this.document.hidden);
  private readonly visibilityRevision = signal(0);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private copyRevision = 0;
  openToolContent(request: ToolContentRequest): void {
    const items = this.store.presentedItems();
    const item = items.find(item => item.id === request.itemId) ?? items.find(item => item.receipt?.id === request.itemId);
    const toolId = item?.toolId ?? item?.id;
    this.contentSource.set(item?.kind === 'tool_use' || item?.kind === 'tool_result' ? {
      inputId: item.kind === 'tool_use' ? item.id : items.find(value => value.kind === 'tool_use' && (value.toolId ?? value.id) === toolId)?.id,
      outputId: item.kind === 'tool_result' ? item.id : item.receipt?.id ?? [...items].reverse().find(value => value.kind === 'tool_result' && value.toolId === toolId)?.id,
    } : undefined);
    this.contentPart.set(request.part);
    this.contentId.set(request.itemId);
  }
  readonly selection = input<ChatSelection | null>(null);
  readonly streamAvailable = input(false);
  readonly creation = input<StartingSession | null>(null);
  /** Stable through a create receipt, including one that arrives before first paint. */
  readonly creationKey = input<string | null>(null);
  readonly creationRetry = output<void>();
  readonly creationCheck = output<void>();
  readonly creationDiscard = output<void>();
  readonly archived = input(false);
  readonly workspaceUnavailable = input(false);
  readonly active = input(true);
  readonly machineName = input('the machine');
  readonly reconnectAction = input('Try now');
  readonly outageSince = input<number | null>(null);
  readonly reconnectRequested = output<void>();
  readonly mentionItems = input<readonly ConversationMention[]>([]);
  readonly sessionTitle = input('');
  readonly agentFocus = input<AgentChatFocus | null>(null);
  readonly agentNavigationBusy = input(false);
  readonly agentNavigationError = input('');
  readonly agentSessionRequested = output<{ readonly source: ChatSelection; readonly intent: AgentWorkIntent & { readonly target: { readonly kind: 'session'; readonly session: SessionAgentReference } } }>();
  /** Without a tab, the browser picks on its current page. */
  readonly browserPickRequested = output<ChatSelection & { readonly tabId?: string }>();
  pickBrowserElement(tabId?: string): void {
    const selection = this.selection();
    if (selection && !this.store.readOnly() && !this.store.busy()) this.browserPickRequested.emit({ ...selection, ...(tabId ? { tabId } : {}) });
  }
  readonly fileLinkRequested = output<ChatSelection & { readonly path: string }>();
  readonly reviewRequested = output<ChatSelection & { readonly turnId: string; readonly path?: string }>();
  readonly store = inject(SessionChatStore);
  private readonly agentTurns = new SessionAgentTurnProjection();
  protected readonly exchanges = computed(() => this.agentTurns.project(this.store.exchanges(), this.store.state(), this.selection()?.taskId),
    { equal: (left, right) => left.length === right.length && left.every((exchange, index) => exchange === right[index]) });
  protected readonly delegated = computed(() => this.store.state()?.delegation);
  protected readonly agentNavigationDisabled = computed(() => this.store.offline() || this.agentNavigationBusy());
  protected readonly agentTitle = sessionAgentTitle;
  protected readonly agentIdentity = agentIdentity;
  protected readonly decisionAgents = computed(() => this.archived() ? [] :
    this.store.state()?.work?.sessions?.filter(agent => agent.status === 'waiting') ?? []);
  protected readonly retainedDecisions = linkedSignal<
    { readonly identity: string; readonly agents: readonly DelegatedSessionWork[] },
    readonly DelegatedSessionWork[]
  >({
    source: () => ({ identity: this.identity(), agents: this.decisionAgents() }),
    computation: ({ identity, agents }, previous) =>
      agents.length || previous?.source.identity !== identity ? agents : previous.value,
  });
  protected readonly moreDecisions = signal(false);
  private readonly agentClient = inject(SessionChatClient);
  private readonly stoppingAgents = new Set<number>();
  /** One scroll/editor lifetime per selected session, retained through recovery. */
  readonly chatViews = computed(() => [{ revision: this.store.viewRevision() }]);
  readonly modelCatalog = new SessionChatModels(inject(SessionChatClient));
  private readonly catalogTarget = computed(() => {
    const selection = this.selection();
    const state = this.store.state();
    return selection && state?.presetCatalogs && this.active() && !this.store.offline() && !this.archived()
      ? `${selection.scopeId}/${selection.taskId}/${selection.sessionId}/${state.provider}` : null;
  });
  refreshModels(): void {
    const selection = this.selection();
    const provider = this.store.state()?.provider;
    if (this.catalogTarget() && selection && provider && !this.store.busy() && !this.store.historical())
      void this.modelCatalog.load(selection, provider, true);
  }
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
  /**
   * Browser context is staged for review; it never submits a prompt. An element
   * drops its pin at the caret, so pointing reads like part of the sentence.
   * Returns the pin (0 for text-only context), or null when nothing was staged.
   */
  stageBrowserContext(text: string, element?: BrowserElementSnapshot): number | null {
    if (this.store.readOnly() || this.store.historical() || this.store.busy() || this.store.uncertain()) { this.attachments.error.set('This conversation cannot add context right now. Finish the pending action or choose an active conversation.'); return null; }
    let marker = 0;
    if (element) {
      if (!this.store.state()?.browserElements) { this.attachments.error.set('This engine or harness cannot send element images. Update it or choose a harness with image support.'); return null; }
      const staged = this.attachments.addElement(element);
      if (!staged) return null;
      marker = staged;
    }
    if (text.trim()) {
      const previous = this.store.draft();
      this.store.setDraft((previous ? previous + '\n\n' : '') + text);
    }
    const composer = this.composer();
    if (marker && composer && !elementMarkersIn(composer.draft()).includes(marker)) composer.insertElement(marker);
    else composer?.focusEditor();
    return marker;
  }
  readonly composer = viewChild(ComposerComponent);
  readonly chat = viewChild(ChatComponent);
  private readonly injector = inject(Injector);
  readonly requestElement = viewChild<unknown, ElementRef<HTMLElement>>(
    "request",
    {
      read: ElementRef,
    },
  );
  readonly message = computed(
    () => this.store.error() || this.store.uncertain() || this.store.streamError() || this.store.state()?.error || "",
  );
  protected readonly opening = computed(() => !!this.selection() && this.active() && this.store.loading() &&
    !this.store.state() && !this.store.starting() && !this.store.offline() && !this.message());
  readonly copiedCode = signal<string | null>(null);
  readonly agentId = signal<string | null>(null);
  readonly agentOrigin = signal<HTMLElement | null>(null);
  readonly inspectedStatus = computed(() => this.store.state()?.work?.recent.find(item => item.agentId === this.agentId())?.agentStatus);
  /** The inspected agent's live Activity record, while it is still listed. */
  readonly agentWork = computed(() => {
    const id = this.agentId();
    return (
      this.store.state()?.work?.running.find((item) => item.agentId === id) ??
      null
    );
  });
  readonly contentId = signal<string | null>(null);
  readonly editingPrompt = signal<string | null>(null);
  readonly contentSource = signal<ToolContentSource | undefined>(undefined);
  readonly contentPart = signal<'input' | 'text'>('text');
  readonly identity = computed(
    () =>
      this.creationKey() ?? this.creation()?.id ?? `${this.selection()?.scopeId}:${this.selection()?.taskId}:${this.selection()?.sessionId}`,
  );
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly usageTime = signal(Date.now());
  readonly blocked = computed(
    () =>
      (this.store.offline() && !this.store.outbox) ||
      !!this.store.busy() ||
      !!this.store.uncertain() ||
      this.archived() ||
      this.workspaceUnavailable() ||
      !this.store.state(),
  );
  readonly activityDisabledReason = computed(() => this.workspaceUnavailable() ? 'Prepare the workspace to continue.' : this.archived() ? 'This session is archived. Activity is read only.'
    : this.store.offline() ? 'Reconnect to control this work.'
    : this.store.uncertain() ? 'Check the previous action’s outcome before another action.'
    : this.store.busy() ? 'An action is in progress.' : '');
  private readonly modelLimits = computed(
    () => sessionModelLimits(this.store.state()?.modelQuota, this.usageTime()),
    { equal: equalViewData },
  );
  readonly models = computed<readonly AgentModel[]>(() => {
    const state = this.store.state();
    const limits = this.modelLimits();
    const catalog = this.modelCatalog.value();
    const catalogModels = state && catalog?.provider === state.provider ? catalog.models : [];
    const models = state?.provider === 'antigravity' && !state.providerLocked && catalogModels.length
      ? catalogModels
      : state?.models.length ? state.models : catalogModels;
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      thinking: model.reasoningEfforts ?? [],
      supportsFastMode: model.supportsFastMode,
      ...limitFor(limits, model.id),
    }));
  }, { equal: equalViewData });
  readonly providers = computed(() => this.store.state()?.providers ?? [], { equal: equalViewData });
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
  }, { equal: equalViewData });
  readonly showWelcome = computed(
    () =>
      !this.archived() &&
      (this.store.starting() || !!this.store.state()) &&
      this.store.empty() &&
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
    focusPreset: (id) => this.focusPreset(id),
  });
  protected readonly presetEditing = computed(() =>
    this.showWelcome() && this.presetFlow.canEdit() && this.presetFlow.editing() &&
    !this.store.starting() && !this.store.compactStart(),
  );
  protected readonly presetHeadingActions = computed<readonly ("edit" | "new")[]>(() => {
    if (!this.presetFlow.canEdit() || (!this.presetFlow.presets().length && !this.presetEditing())) return ["new"];
    return this.presetEditing() ? ["new", "edit"] : ["edit", "new"];
  });
  focusPreset(id?: string): void {
    afterNextRender(() => {
      const card = id && this.element.querySelector(
        `[data-flip="${CSS.escape(id)}"] ex-preset-card button`,
      );
      const fallback = this.element.querySelector<HTMLButtonElement>("[data-preset-edit]") ??
        this.element.querySelector<HTMLButtonElement>("[data-preset-new]");
      (card instanceof HTMLButtonElement ? card : fallback)?.focus();
    }, { injector: this.injector });
  }
  setPresetEditing(editing: boolean): void {
    this.presetFlow.setEditing(editing);
    this.focusPreset();
  }
  protected onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.presetEditing() && !this.presetFlow.creatorOpen() &&
      !event.defaultPrevented && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.setPresetEditing(false);
      return;
    }
    this.presetFlow.presetShortcut(event);
  }
  nameNewPreset(): void {
    this.presetFlow.startNaming();
    afterNextRender(() => {
      this.element.querySelector<HTMLInputElement>(".preset-change input")?.focus();
    }, { injector: this.injector });
  }
  cancelPresetName(): void {
    this.presetFlow.naming.set(false);
    afterNextRender(() => {
      this.element.querySelector<HTMLButtonElement>("[data-name-preset]")?.focus();
    }, { injector: this.injector });
  }
  readonly agent = computed<AgentConfig | undefined>(() => {
    const state = this.store.state();
    if (!state) return undefined;
    const catalog = this.modelCatalog.value();
    const discovered = state.provider === 'antigravity' && !state.providerLocked && catalog?.provider === state.provider
      ? catalog : null;
    const model = state.model ?? discovered?.model ?? '';
    return {
      preset: this.presetFlow.selectedPreset()?.preset,
      presetEdited: this.showWelcome() && !!this.presetFlow.drift(),
      harnessLabel: this.providerLabel(),
      harness: state.provider,
      mark:
        this.harnesses().find((harness) => harness.id === state.provider)
          ?.mark ?? "Ag",
      model,
      modelLabel: state.models.find(option => option.id === model)?.label ??
        discovered?.models.find(option => option.id === model)?.label ?? model,
      thinking: state.reasoning ?? (model === discovered?.model ? discovered?.reasoning ?? undefined : undefined),
      fast: state.fast,
      context: state.context ? state.context.percentage / 100 : undefined,
      tokens: state.context
        ? `${this.tokenNumber.format(state.context.tokens).toLowerCase()} of ${this.tokenNumber.format(state.context.limit).toLowerCase()}`
        : undefined,
      plan:
        sessionPlanUsage(state.planUsage, this.usageTime()) ??
        sessionModelPlan(state.modelQuota, this.modelLimits().find((limit) => limit.id === model), this.providerLabel()),
    };
  }, { equal: equalViewData });
  readonly editedPreset = computed<AgentConfig | undefined>(() => {
    const saved = this.presetFlow.drift()?.saved;
    const agent = this.agent();
    return saved && agent ? { ...agent, id: saved.id, preset: saved.preset, default: saved.default } : undefined;
  }, { equal: equalViewData });
  readonly fastAvailable = computed(() => {
    const state = this.store.state();
    return (
      !!state?.controls?.fast &&
      (state.fast === true ||
        this.models().find((model) => model.id === state.model)
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
      this.modelCatalog.loading() ||
      this.store.loading()
    )
      return;
    if (value.harness !== current.harness || value.model !== current.model ||
      value.thinking !== current.thinking || value.fast !== current.fast)
      this.presetFlow.trackTweak();
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
  readonly permissions = computed<readonly PermissionChoice[]>(() => {
    const state = this.store.state();
    return (state?.permissionModes ?? []).map((id) => ({
      id,
      detail:
        (
          {
            default: "Ask before the agent takes protected actions",
            acceptEdits: "Apply edits; ask before commands",
            "accept-edits": "Approve workspace edits automatically",
            bypassPermissions: state?.provider === "antigravity"
              ? "Automatically approve Antigravity tool requests"
              : "Allow actions without permission prompts",
            auto: state?.provider === "antigravity"
              ? "Approve edits and run routine commands automatically"
              : "Use the harness’s automatic permission policy",
            plan: "Read and propose before making changes",
            dontAsk: "Deny actions that need permission",
          } as Readonly<Record<string, string>>
        )[id] ?? "Use this harness permission policy",
      label:
        (
          {
            default: "Ask first",
            acceptEdits: "Auto-edit",
            "accept-edits": "Accept edits",
            bypassPermissions: state?.provider === "antigravity" ? "Full access" : "Full auto",
            auto: "Auto",
            plan: "Plan",
            dontAsk: "Do not ask",
          } as Readonly<Record<string, string>>
        )[id] ?? id,
    }));
  }, { equal: equalViewData });
  readonly questions = computed<readonly AgentQuestion[]>(() =>
    (this.store.state()?.question?.questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      kind: q.multiple ? "multi" : "single",
      options: q.options.map((o) => ({ label: o.label, detail: o.detail })),
    })),
    { equal: equalViewData },
  );

  dragOver(event: DragEvent): void {
    if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
    if (this.presetEditing()) event.preventDefault();
    else if (this.store.state()?.attachments) this.composer()?.dragOver(event);
  }
  dropFiles(event: DragEvent): void {
    if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
    if (this.presetEditing()) event.preventDefault();
    else if (this.store.state()?.attachments) this.composer()?.drop(event);
  }
  constructor() {
    effect((cleanup) => {
      const target = this.catalogTarget();
      untracked(() => {
        const selection = this.selection();
        const provider = this.store.state()?.provider;
        if (target && selection && provider) void this.modelCatalog.load(selection, provider);
      });
      cleanup(() => this.modelCatalog.reset());
    });
    const view = this.document.defaultView;
    const foreground = () => this.foreground.set(this.document.hasFocus() && !this.document.hidden);
    view?.addEventListener('focus', foreground);
    view?.addEventListener('blur', foreground);
    this.document.addEventListener('visibilitychange', foreground);
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('focus', foreground);
      view?.removeEventListener('blur', foreground);
      this.document.removeEventListener('visibilitychange', foreground);
    });
    afterRenderEffect(cleanup => {
      // Shell takeovers and modal layers retain the chat under inert ancestors.
      // Observe only those ancestors, never the streamed transcript subtree.
      const observer = new MutationObserver(() => this.visibilityRevision.update(value => value + 1));
      for (let parent: HTMLElement | null = this.element; parent; parent = parent.parentElement)
        observer.observe(parent, { attributes: true, attributeFilter: ['inert', 'hidden'] });
      cleanup(() => observer.disconnect());
    });
    effect(() => {
      const selection = this.selection();
      const creation = this.creation();
      const active = this.active(), archived = this.archived() || this.workspaceUnavailable(), streamAvailable = this.streamAvailable();
      untracked(() => {
        this.store.setActive(active);
        if (creation) this.store.openDraft(creation);
        else if (selection) this.store.open(selection, archived, streamAvailable);
        this.attachments.open(creation ? null : selection);
      });
    });
    effect(() => {
      const selection = this.creation() ? null : this.selection();
      const items = this.store.presentedItems();
      untracked(() => this.media.update(selection, items));
    });
    effect(() => {
      this.identity();
      this.presetFlow.reset();
      this.editingPrompt.set(null);
      this.copyRevision++;
      clearTimeout(this.copyTimer);
      this.copiedCode.set(null);
    });
    effect(() => {
      this.store.viewRevision();
      this.contentId.set(null);
      this.agentId.set(null);
      this.agentOrigin.set(null);
      this.moreDecisions.set(false);
      this.stoppingAgents.clear();
    });
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
      // Cached history is already usable while its refresh is pending. Position
      // that first render too; a refresh must never pull an active reader down.
      const ready = !!this.store.state();
      const scroll = this.chat()?.scroll();
      if (!opening || !ready || !scroll) return;
      opening = false;
      // Hydrated history must be positioned before paint, without scroll animation.
      untracked(() => scroll.scrollToEnd("instant"));
    });
    let focusedAgent: AgentChatFocus | null = null;
    afterRenderEffect(() => {
      const intent = this.agentFocus(), selection = this.selection();
      const chat = this.chat(), request = this.requestElement()?.nativeElement;
      if (!intent || intent === focusedAgent || intent.selection !== selection || !chat ||
          !this.store.state() || this.store.loading() || !this.active()) return;
      focusedAgent = intent;
      untracked(() => {
        if (intent.action === 'message' && !this.archived()) this.focusComposer();
        else if (intent.action === 'answer' && request) chat.scroll()?.revealAgentAnchor(request);
        else if (!chat.focusAgent(intent.from, intent.itemId)) {
          const breadcrumb = this.element.querySelector<HTMLElement>('.delegation-breadcrumb');
          if (breadcrumb) breadcrumb.focus({ preventScroll: true });
          else chat.scroll()?.viewport().nativeElement.focus({ preventScroll: true });
        }
      });
    });
    afterRenderEffect(() => {
      this.visibilityRevision();
      const at = this.store.state()?.unseenCompletionAt;
      const ready = !this.store.loading() && !this.store.historical() && !this.store.next();
      const atEnd = this.chat()?.scroll()?.atEnd();
      if (at && ready && atEnd && this.active() && this.foreground() && !this.element.closest('[inert], [hidden]'))
        untracked(() => { void this.store.markSeen(); });
    });
    effect((cleanup) => {
      const state = this.store.state();
      if (!state?.planUsage && !state?.modelQuota?.models.length) return;
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
  async latest(): Promise<void> {
    const revision = this.store.viewRevision();
    if (!await this.store.refresh()) return;
    afterNextRender(() => {
      if (this.store.viewRevision() === revision) this.chat()?.scroll()?.scrollToEnd("instant");
    }, { injector: this.injector });
  }
  focusDecision(): void {
    this.chat()?.scroll()?.scrollToEnd();
    this.requestElement()?.nativeElement.focus({ preventScroll: true });
  }
  protected openParent(session: SessionAgentReference, event: Event): void {
    this.agentIntent({ target: { kind: 'session', session }, action: 'return', origin: agentControl(event) });
  }
  protected openDecision(session: SessionAgentReference, event: Event): void {
    this.agentIntent({ target: { kind: 'session', session }, action: 'answer', origin: agentControl(event) });
  }
  protected agentIntent(intent: AgentWorkIntent): void {
    if (intent.target.kind === 'native') {
      this.agentOrigin.set(intent.origin ?? null);
      this.agentId.set(intent.target.agentId);
      return;
    }
    const source = this.selection();
    if (!source || this.agentNavigationDisabled()) return;
    if (intent.action === 'stop') {
      void this.stopDelegate(source, intent.target.session);
      return;
    }
    this.agentSessionRequested.emit({ source, intent: { ...intent, target: intent.target } });
  }
  private async stopDelegate(source: ChatSelection, session: SessionAgentReference): Promise<void> {
    const id = session.sessionId;
    const active = this.store.state()?.work?.sessions?.find(row => row.session.sessionId === id);
    if (this.archived() || !active || (active.status !== 'running' && active.status !== 'waiting') ||
        active.session.taskId !== source.taskId || this.stoppingAgents.has(id)) return;
    this.stoppingAgents.add(id);
    const result = await this.agentClient.command(source.scopeId, { taskId: source.taskId, sessionId: id, action: { type: 'stop' } });
    if (source !== this.selection()) return;
    if (result.ok || result.error.code !== 'outcome-unknown') this.stoppingAgents.delete(id);
    if (!result.ok) this.store.error.set(result.error.message);
    else this.store.notice.set('Stop requested for ' + sessionAgentTitle(session));
  }
  focusComposer(): void {
    this.composer()?.focusEditor();
  }
  openPromptEditor(itemId: string): void {
    if (!this.selection() || this.archived() || this.store.promptEditDisabledReason()) return;
    this.editingPrompt.set(itemId);
  }
  closePromptEditor(edited: boolean): void {
    this.editingPrompt.set(null);
    if (!edited) return;
    this.chat()?.scroll()?.scrollToEnd('instant');
    this.focusComposer();
  }
  submit(submission: ComposerSubmission): void {
    if (this.presetEditing()) return;
    void this.store.submit(submission, text => this.composer()?.writeDraft(text));
  }
  queueAction(type: "steer-queued" | "cancel-queued", id: string): void {
    this.focusComposer();
    void this.store.perform({ type, id });
  }
  resumeQueue(): void {
    this.focusComposer();
    void this.store.perform({ type: 'resume-queue' });
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
  openFileLink(path: string): void {
    const selection = this.selection();
    if (selection && !this.store.offline()) this.fileLinkRequested.emit({ ...selection, path });
  }
  openFile(path: string): void {
    this.store.notice.set(path);
    const turn = this.store.exchanges().filter(exchange => exchange.files?.some(file => file.path === path)).at(-1) ?? this.store.exchanges().at(-1);
    if (turn) this.review(turn.id, path);
  }
}
