import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  output,
  signal,
} from "@angular/core";
import type { SessionChatContent } from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import {
  ButtonComponent,
  IconButtonComponent,
  ModalLayerComponent,
} from "../ui";
import type { ChatSelection } from "./session-chat.store";

/** A bounded original-content reader; output is always text, including tool-generated HTML. */
@Component({
  selector: "ex-session-chat-content",
  imports: [ModalLayerComponent, ButtonComponent, IconButtonComponent],
  templateUrl: "./session-chat-content.component.html",
  styleUrl: "./session-chat-content.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionChatContentComponent {
  readonly selection = input.required<ChatSelection>();
  readonly itemId = input.required<string>();
  readonly closed = output<void>();
  readonly copyRequested = output<string>();
  readonly open = signal(true);
  readonly part = model<"text" | "input">("text");
  readonly previousOffsets = signal<readonly number[]>([]);
  readonly offset = signal(0);
  readonly page = signal<SessionChatContent | null>(null);
  readonly busy = signal(true);
  readonly error = signal("");
  private readonly client = inject(SessionChatClient);
  private request: { scope: string; id: string } | undefined;
  private generation = 0;
  constructor() {
    effect(() => {
      void this.load(
        this.selection(),
        this.itemId(),
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
  switchPart(part: "text" | "input"): void {
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
  reload(): void {
    void this.load(this.selection(), this.itemId(), this.part(), this.offset());
  }
  private async load(
    target: ChatSelection,
    itemId: string,
    part: "text" | "input",
    offset: number,
  ): Promise<void> {
    this.cancel();
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
