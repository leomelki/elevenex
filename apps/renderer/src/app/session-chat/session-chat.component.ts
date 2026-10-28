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
  ChatComponent,
  ComposerComponent,
  QuestionCardComponent,
  type AgentQuestion,
  type QuestionAnswers,
  type TurnAction,
} from "../conversation";
import {
  ButtonComponent,
  ContextMeterComponent,
  DropdownComponent,
  IconComponent,
  SkeletonComponent,
  StatusGlyphComponent,
} from "../ui";
import { SessionChatStore, type ChatSelection } from "./session-chat.store";
import { SessionChatContentComponent } from "./session-chat-content.component";

@Component({
  selector: "ex-session-chat",
  providers: [SessionChatStore],
  imports: [
    SessionChatContentComponent,
    ChatComponent,
    ComposerComponent,
    ApprovalCardComponent,
    QuestionCardComponent,
    ButtonComponent,
    DropdownComponent,
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
  private readonly identity = computed(
    () =>
      `${this.selection().scopeId}:${this.selection().taskId}:${this.selection().sessionId}`,
  );
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
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
  readonly models = computed(() => [
    { id: "", label: "Provider default" },
    ...(this.store.state()?.models ?? []),
  ]);
  readonly permissions = computed(() =>
    (this.store.state()?.permissionModes ?? []).map((id) => ({
      id,
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
    inject(DestroyRef).onDestroy(() => clearTimeout(this.copyTimer));
  }
  focusDecision(): void {
    this.chat()?.scroll()?.scrollToEnd();
    this.requestElement()?.nativeElement.focus({ preventScroll: true });
  }
  focusComposer(): void {
    this.composer()?.textarea()?.nativeElement.focus();
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
