import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  ElementRef,
  viewChild,
  afterRenderEffect,
} from "@angular/core";
import { OpensWhenBackComponent } from "../machines";
import type { SessionChatContent } from "@elevenex/shared";
import type { ToolContentSource } from "../conversation";
import { SessionChatClient } from "../backend/session-chat-client.service";
import {
  ButtonComponent,
  IconButtonComponent,
  ModalLayerComponent,
  SegmentedComponent,
} from "../ui";
import type { ChatSelection } from "./session-chat.store";

/** A bounded original-content reader; output is always text, including tool-generated HTML. */
@Component({
  selector: "ex-session-chat-content",
  imports: [
    OpensWhenBackComponent,
    ModalLayerComponent,
    ButtonComponent,
    IconButtonComponent,
    SegmentedComponent,
  ],
  templateUrl: "./session-chat-content.component.html",
  styleUrl: "./session-chat-content.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionChatContentComponent {
  readonly selection = input.required<ChatSelection>();
  readonly itemId = input.required<string>();
  readonly source = input<ToolContentSource>();
  readonly unreachable = input<string>();
  readonly reconnectRequested = output<void>();
  readonly closed = output<void>();
  readonly copyRequested = output<string>();
  readonly open = signal(true);
  readonly part = model<"text" | "input">("text");
  protected readonly parts = [{ id: 'text', label: 'Output' }, { id: 'input', label: 'Input' }] as const;
  readonly previousOffsets = signal<readonly number[]>([]);
  readonly offset = signal(0);
  readonly page = signal<SessionChatContent | null>(null);
  readonly canReturnToLoaded = computed(() => {
    const page = this.page();
    return (
      !!page &&
      [this.itemId(), this.source()?.inputId, this.source()?.outputId].includes(
        page.itemId,
      )
    );
  });
  readonly selectedId = computed(
    () =>
      (this.part() === "input"
        ? this.source()?.inputId
        : this.source()?.outputId) ?? this.itemId(),
  );
  readonly visiblePage = computed(() => {
    const page = this.page();
    return page?.itemId === this.selectedId() &&
      page.part === this.part() &&
      page.offset === this.offset()
      ? page
      : null;
  });
  readonly busy = signal(true);
  readonly error = signal("");
  private readonly client = inject(SessionChatClient);
  private request: { scope: string; id: string } | undefined;
  private generation = 0;
  private readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private positionPage = '';
  constructor() {
    afterRenderEffect(() => {
      const page = this.visiblePage();
      const content = this.content()?.nativeElement;
      if (!page || !content) return;
      const key = `${page.itemId}:${page.part}:${page.offset}`;
      if (key !== this.positionPage) content.scrollTop = 0;
      this.positionPage = key;
    });
    effect(() => {
      void this.load(
        this.selection(),
        this.selectedId(),
        this.part(),
        this.offset(),
      );
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }
  private cancel(): void {
    this.generation++;
    if (this.request) this.client.cancel(this.request.scope, this.request.id);
    this.request = undefined;
  }
  close(): void {
    this.open.set(false);
    this.cancel();
  }
  switchPart(part: string): void {
    if ((part !== 'text' && part !== 'input') || part === this.part()) return;
    this.part.set(part);
    this.offset.set(0);
    this.previousOffsets.set([]);
  }
  next(): void {
    const next = this.page()?.nextOffset;
    if (next != null) {
      this.previousOffsets.update((offsets) => [...offsets, this.offset()]);
      this.offset.set(next);
    }
  }
  previous(): void {
    const offsets = this.previousOffsets();
    const offset = offsets.at(-1);
    if (offset !== undefined) {
      this.offset.set(offset);
      this.previousOffsets.set(offsets.slice(0, -1));
    }
  }
  returnToLoaded(): void {
    const page = this.page();
    if (page && this.canReturnToLoaded()) {
      this.part.set(page.part);
      this.offset.set(page.offset);
    }
  }
  reload(): void {
    void this.load(
      this.selection(),
      this.selectedId(),
      this.part(),
      this.offset(),
    );
  }
  private async load(
    target: ChatSelection,
    itemId: string,
    part: "text" | "input",
    offset: number,
  ): Promise<void> {
    this.cancel();
    if (!this.open() || this.unreachable()) {
      this.busy.set(false);
      return;
    }
    const generation = this.generation,
      requestId = crypto.randomUUID();
    this.request = { scope: target.scopeId, id: requestId };
    this.busy.set(true);
    this.error.set("");
    const result = await this.client.content(target.scopeId, {
      taskId: target.taskId,
      sessionId: target.sessionId,
      itemId,
      part,
      offset,
      requestId,
    });
    if (generation !== this.generation) return;
    this.request = undefined;
    this.busy.set(false);
    if (result.ok) this.page.set(result.value);
    else this.error.set(result.error.message);
  }
}
