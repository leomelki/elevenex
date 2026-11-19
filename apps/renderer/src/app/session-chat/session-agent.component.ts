import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
  ChatScrollComponent,
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

/** On-demand child history, stitched into a bounded scrolling window. */
@Component({
  selector: "ex-session-agent",
  imports: [
    ChatScrollComponent,
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
  private readonly newer = signal<readonly (string | undefined)[]>([]);
  readonly hasNewer = computed(() => this.newer().length > 0);
  /** Live and saved records retain the same task title and secondary identity. */
  protected readonly heading = computed(
    () =>
      this.work()?.title ||
      this.page()?.title ||
      this.page()?.label ||
      "Agent details",
  );
  protected readonly identity = computed(() => {
    const work = this.work();
    return work?.title
      ? (work.agentName ?? work.role ?? "")
      : (this.page()?.agentName ?? "");
  });
  protected readonly agentRole = computed(() =>
    this.work()?.agentName || this.page()?.agentName
      ? (this.work()?.role ?? this.page()?.role ?? "")
      : "",
  );
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
        .filter(
          (item) => !(item.kind === "user" && item.text.trim() === prompt),
        )
        .filter(
          (item) =>
            item.kind !== "tool_result" || !calls.has(item.toolId ?? item.id),
        )
        .map((item): AgentRow => {
          if (item.kind === "tool_use") {
            const result = results.get(item.toolId ?? item.id);
            const tool = presentSessionTool(item, result);
            const outcome =
              result?.error || item.error || tool.shell?.failed || tool.shell?.interrupted
                ? "failed"
                : !result && !live
                  ? "unknown"
                  : undefined;
            return {
              item,
              tool,
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
    viewChild<ChatScrollComponent>("transcript");
  private request: { scope: string; id: string } | undefined;
  /** Refresh alone resets position; adjacent pages preserve the visible row. */
  private resetScroll = true;
  readonly windowRevision = signal(0);
  private pages: { cursor: string | undefined; page: SessionChatAgentPage }[] = [];
  private generation = 0;
  constructor() {
    effect(() => {
      void this.load(
        this.selection(),
        this.agentId(),
        undefined,
        this.unreachable(),
      );
    });
    afterRenderEffect(() => {
      this.page();
      if (this.resetScroll && this.page()) {
        this.transcript()?.scrollToEnd("instant");
        this.resetScroll = false;
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
      undefined,
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
    if (!cursor || this.busy() || this.unreachable()) return;
    void this.load(this.selection(), this.agentId(), cursor, false, "before");
  }
  later(): void {
    if (!this.newer().length || this.busy() || this.unreachable()) return;
    void this.load(this.selection(), this.agentId(), this.newer().at(-1), false, "following");
  }
  latest(): void { this.refresh(); }
  private async load(
    target: ChatSelection,
    agentId: string,
    before: string | undefined,
    unreachable: boolean,
    direction?: "before" | "following",
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
      if (!direction) {
        this.pages = [{ cursor: before, page: result.value }];
        this.newer.set([]);
        this.resetScroll = true;
      } else if (direction === "before") {
        this.pages.unshift({ cursor: before, page: result.value });
        while (this.pages.length > 4) {
          const removed = this.pages.pop()!;
          this.newer.update(cursors => [...cursors, removed.cursor]);
        }
      } else {
        this.pages.push({ cursor: before, page: result.value });
        this.newer.update(cursors => cursors.slice(0, -1));
        while (this.pages.length > 4)
          this.pages.shift();
      }
      const items = [...new Map(this.pages.flatMap(value => value.page.items).map(item => [item.id, item])).values()];
      this.page.set({ ...result.value, items, before: this.pages[0]?.page.before ?? null });
      const retained = new Set(items.map(item => item.id));
      this.reasoningOpen.update(ids => new Set([...ids].filter(id => retained.has(id))));
      if (direction) this.windowRevision.update(value => value + 1);
      this.loadedAt.set(clock.format(Date.now()));
      // Short assignments read at a glance; long ones stay folded behind their preview.
      if (before === undefined && !this.assignmentTouched)
        this.assignmentOpen.set(result.value.prompt.length <= 160);
    } else this.error.set(result.error.message);
  }
}
