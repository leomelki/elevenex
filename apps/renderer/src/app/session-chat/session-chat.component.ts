import {
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
  viewChild,
} from "@angular/core";
import {
  ApprovalCardComponent,
  AgentUsageNoticeComponent,
  ChatComponent,
  ComposerComponent,
  QuestionCardComponent,
  type AgentQuestion,
  type QuestionAnswers,
  type TurnAction,
  type AgentConfig,
  type AgentHarness,
  type AgentModel,
  type PermissionChoice,
} from "../conversation";
import {
  ButtonComponent,
  ContextMeterComponent,
  IconComponent,
  SkeletonComponent,
  StatusGlyphComponent,
} from "../ui";
import { SessionChatStore, type ChatSelection } from "./session-chat.store";
import { SessionChatContentComponent } from "./session-chat-content.component";
import { sessionPlanUsage } from "./session-chat-usage";

@Component({
  selector: "ex-session-chat",
  providers: [SessionChatStore],
  imports: [
    SessionChatContentComponent,
    ChatComponent,
    ComposerComponent,
    ApprovalCardComponent,
    AgentUsageNoticeComponent,
    QuestionCardComponent,
    ButtonComponent,
    ContextMeterComponent,
    StatusGlyphComponent,
    SkeletonComponent,
    IconComponent,
  ],
  templateUrl: "./session-chat.component.html",
  styleUrl: "./session-chat.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionChatComponent {
  readonly selection = input.required<ChatSelection>();
  readonly archived = input(false);
  readonly reviewRequested = output<void>();
  readonly store = inject(SessionChatStore);
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
  readonly contentId = signal<string | null>(null);
  readonly contentPart = computed(() =>
    this.store.items().find((item) => item.id === this.contentId())?.kind ===
    "tool_use"
      ? ("input" as const)
      : ("text" as const),
  );
  readonly identity = computed(
    () =>
      `${this.selection().scopeId}:${this.selection().taskId}:${this.selection().sessionId}`,
  );
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly usageTime = signal(Date.now());
  readonly status = computed(() =>
    this.store.state()?.permission || this.store.state()?.question
      ? "attention"
      : this.store.running()
        ? "running"
        : this.store.state()?.phase === "error"
          ? "failed"
          : "done",
  );
  readonly statusLabel = computed(() =>
    this.status() === "attention"
      ? "Needs you"
      : this.status() === "running"
        ? "Running"
        : this.status() === "failed"
          ? "Failed"
          : "Ready",
  );
  readonly blocked = computed(
    () =>
      !!this.store.busy() ||
      !!this.store.uncertain() ||
      this.archived() ||
      !this.store.state(),
  );
  readonly models = computed<readonly AgentModel[]>(() => [
    { id: "", label: "Provider default", thinking: [] },
    ...(this.store.state()?.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      thinking: model.reasoningEfforts ?? [],
      supportsFastMode: model.supportsFastMode,
    })),
  ]);
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
  readonly agent = computed<AgentConfig | undefined>(() => {
    const state = this.store.state();
    if (!state) return undefined;
    return {
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

  constructor() {
    effect(() => this.store.open(this.selection(), this.archived()));
    effect(() => {
      this.identity();
      this.contentId.set(null);
    });
    effect((cleanup) => {
      if (!this.store.state()?.planUsage) return;
      this.usageTime.set(Date.now());
      const timer = setInterval(() => this.usageTime.set(Date.now()), 30_000);
      cleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.copyTimer));
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
    try {
      await navigator.clipboard.writeText(text);
      this.store.notice.set("Copied");
      if (code) {
        clearTimeout(this.copyTimer);
        this.copiedCode.set(text);
        this.copyTimer = setTimeout(() => this.copiedCode.set(null), 2000);
      }
    } catch {
      this.store.error.set(
        "Could not copy. Select the text and copy it manually.",
      );
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
  openFile(path: string): void {
    this.store.notice.set(path);
    this.reviewRequested.emit();
  }
}
