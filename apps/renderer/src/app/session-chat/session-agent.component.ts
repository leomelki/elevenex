import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import type {
  SessionChatAgentPage,
  SessionChatBackgroundWork,
  SessionChatItem,
} from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import {
  MarkdownComponent,
  ToolStepComponent,
  stepIcon,
  type ToolPresentation,
} from "../conversation";
import {
  ButtonComponent,
  ContextMeterComponent,
  FoldComponent,
  IconButtonComponent,
  IconComponent,
  ModalLayerComponent,
  SkeletonComponent,
  StatusBadgeComponent,
  StatusGlyphComponent,
} from "../ui";
import type { ChatSelection } from "./session-chat.store";
import {
  presentSessionTool,
  sessionToolKind,
  sessionToolVerb,
} from "./session-chat-tools";
import { formatUsage } from "./session-activity-model";
import { sessionWorkStatus } from "./session-work-status";

type StepStatus = "running" | "done" | "failed" | "unknown";
interface AgentRow {
  readonly item: SessionChatItem;
  readonly tool: ToolPresentation | null;
  readonly icon: string;
  readonly verb: string;
  readonly status: StepStatus;
}
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const LIVE = new Set(["pending", "running", "waiting"]);

/** On-demand child history. Each page replaces the bounded window; reads never send prompts. */
@Component({
  selector: "ex-session-agent",
  imports: [
    MarkdownComponent,
    ToolStepComponent,
    ButtonComponent,
    ContextMeterComponent,
    FoldComponent,
    IconButtonComponent,
    IconComponent,
    ModalLayerComponent,
    SkeletonComponent,
    StatusBadgeComponent,
    StatusGlyphComponent,
  ],
  templateUrl: "./session-agent.component.html",
  styleUrl: "./session-agent.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionAgentComponent {
  readonly selection = input.required<ChatSelection>();
  readonly agentId = input.required<string>();
  readonly unreachable = input(false);
  /** The live Activity record, when the agent is still listed; supplies usage. */
  readonly work = input<SessionChatBackgroundWork | null>(null);
  readonly copiedCode = input<string | null>(null);
  readonly copyRequested = output<string>();
  readonly linkRequested = output<string>();
  readonly closed = output<void>();
  readonly open = signal(true);
  readonly page = signal<SessionChatAgentPage | null>(null);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly notice = signal("");
  readonly before = signal<string | undefined>(undefined);
  private readonly newer = signal<readonly (string | undefined)[]>([]);
  readonly hasNewer = computed(() => this.newer().length > 0);
  /** Prefer the live record's split title/role; the page label may join them. */
  protected readonly heading = computed(
    () => this.work()?.title || this.page()?.label || "Agent details",
  );
  protected readonly role = computed(() => {
    const work = this.work();
    return work?.title ? (work.role ?? "") : "";
  });
  protected readonly usage = computed(() => {
    const work = this.work();
    return work ? formatUsage(work) : "";
  });
  readonly state = computed(() => sessionWorkStatus(this.page()?.status));
  protected readonly titleId = `session-agent-${crypto.randomUUID()}`;
  protected readonly fileNotice = "Open this file from the task’s Files view.";
  protected readonly pageNotice =
    "Open page previews from the main conversation.";
  /** Long assignments start folded so the transcript keeps the space. */
  readonly assignmentOpen = signal(false);
  private assignmentTouched = false;
  readonly reasoningOpen = signal<ReadonlySet<string>>(new Set());
  readonly loadedAt = signal("");
  readonly rows = computed((): readonly AgentRow[] => {
    const page = this.page();
    const items = page?.items ?? [];
    const prompt = page?.prompt.trim() ?? "";
    const live = LIVE.has(page?.status ?? "");
    const calls = new Set(
      items
        .filter((item) => item.kind === "tool_use")
        .map((item) => item.toolId ?? item.id),
    );
    const results = new Map(
      items
        .filter((item) => item.kind === "tool_result")
        .map((item) => [item.toolId ?? item.id, item]),
    );
    return (
      items
        // The pinned assignment already shows the opening prompt.
        .filter((item) => !(item.kind === "user" && item.text.trim() === prompt))
        .filter(
          (item) =>
            item.kind !== "tool_result" || !calls.has(item.toolId ?? item.id),
        )
        .map((item): AgentRow => {
          if (item.kind === "tool_use") {
            const result = results.get(item.toolId ?? item.id);
            const outcome =
              result?.error || item.error
                ? "failed"
                : !result && !live
                  ? "unknown"
                  : undefined;
            return {
              item,
              tool: presentSessionTool(item, result),
              icon: stepIcon({ id: item.id, kind: sessionToolKind(item) }),
              verb: sessionToolVerb(item, !result && live, outcome),
              status: outcome ?? (result ? "done" : "running"),
            };
          }
          return {
            item,
            tool:
              item.kind === "tool_result"
                ? presentSessionTool({ ...item, input: "" }, item)
                : null,
            icon: "",
            verb: "",
            status: item.error ? "failed" : "done",
          };
        })
    );
  });
  private readonly client = inject(SessionChatClient);
  private readonly transcript =
    viewChild<ElementRef<HTMLElement>>("transcript");
  private request: { scope: string; id: string } | undefined;
  /** Older pages continue upward from what was read; newer pages continue downward. */
  private scrollEdge: "top" | "bottom" = "bottom";
  private generation = 0;
  constructor() {
    effect(() => {
      void this.load(
        this.selection(),
        this.agentId(),
        this.before(),
        this.unreachable(),
      );
    });
    afterRenderEffect(() => {
      this.page();
      const element = this.transcript()?.nativeElement;
      if (element) {
        element.scrollTop =
          this.scrollEdge === "top" ? 0 : element.scrollHeight;
        // Paging disables its trigger while loading. Keep the reader's keyboard
        // focus inside the modal when that button loses focus on becoming disabled.
        if (this.open() && element.ownerDocument.activeElement === element.ownerDocument.body)
          element.focus({ preventScroll: true });
      }
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }
  private cancel(): void {
    this.generation++;
    if (this.request) this.client.cancel(this.request.scope, this.request.id);
    this.request = undefined;
  }
  toggleAssignment(): void {
    this.assignmentTouched = true;
    this.assignmentOpen.update((open) => !open);
  }
  close(): void {
    this.open.set(false);
    this.cancel();
  }
  refresh(): void {
    void this.load(
      this.selection(),
      this.agentId(),
      this.before(),
      this.unreachable(),
    );
  }
  toggleReasoning(id: string): void {
    this.reasoningOpen.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  earlier(): void {
    const cursor = this.page()?.before;
    if (!cursor || this.busy()) return;
    this.scrollEdge = "bottom";
    this.newer.update((values) => [...values.slice(-79), this.before()]);
    this.before.set(cursor);
  }
  later(): void {
    if (!this.newer().length || this.busy()) return;
    this.scrollEdge = "top";
    this.before.set(this.newer().at(-1));
    this.newer.update((values) => values.slice(0, -1));
  }
  latest(): void {
    this.scrollEdge = "bottom";
    this.before.set(undefined);
    this.newer.set([]);
  }
  private async load(
    target: ChatSelection,
    agentId: string,
    before: string | undefined,
    unreachable: boolean,
  ): Promise<void> {
    this.cancel();
    if (!this.open() || unreachable) {
      this.busy.set(false);
      return;
    }
    const generation = this.generation,
      requestId = crypto.randomUUID();
    this.request = { scope: target.scopeId, id: requestId };
    this.busy.set(true);
    this.error.set("");
    const result = await this.client.agent(target.scopeId, {
      taskId: target.taskId,
      sessionId: target.sessionId,
      agentId,
      before,
      requestId,
    });
    if (generation !== this.generation) return;
    this.request = undefined;
    this.busy.set(false);
    if (result.ok) {
      this.page.set(result.value);
      this.loadedAt.set(clock.format(Date.now()));
      // Short assignments read at a glance; long ones stay folded behind their preview.
      if (before === undefined && !this.assignmentTouched)
        this.assignmentOpen.set(result.value.prompt.length <= 160);
    }
    else this.error.set(result.error.message);
  }
}
