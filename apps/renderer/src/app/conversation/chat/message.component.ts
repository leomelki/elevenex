import {
  afterNextRender,
  DestroyRef,
  ElementRef,
  inject,
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { animateMessageSend } from "./message-send-animation";
import type { MessageSendOrigin, TurnAction } from "../conversation.models";
import { TurnActsComponent } from "../turns/turn-acts.component";
@Component({
  selector: "ex-message",
  imports: [TurnActsComponent],
  templateUrl: "./message.component.html",
  styleUrl: "./message.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.user]": 'role() === "user"',
    "[class.agent]": 'role() === "agent"',
    "[class.fresh]": "isNew()",
    "[attr.data-user-message]": 'role() === "user" ? messageId() : null',
    "[attr.id]": "messageId() || null",
    tabindex: "0",
    "(keydown)": "onKey($event)",
  },
})
export class MessageComponent {
  readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private disposeSend?: () => void;
  private arrived = false;
  readonly sendOrigin = input<MessageSendOrigin>();
  constructor() {
    inject(DestroyRef).onDestroy(() => this.disposeSend?.());
    afterNextRender(() => {
      // ChatScroll sequences the scroll and arrival together. Standalone bubbles
      // still support the same rise/fade, without a conversation to reveal.
      if (!this.element.closest('ex-chat-scroll')) this.playArrival();
    });
  }
  /** Internal conversation boundary: called by ChatScroll after revealing us. */
  playArrival(): void {
    if (this.arrived) return;
    this.arrived = true;
    if (this.isNew() && this.role() === 'user')
      this.disposeSend = animateMessageSend(this.element, this.sendOrigin());
  }
  /** Internal scroll handoff: release a flight immediately when the reader takes over. */
  finishArrival(): void {
    this.disposeSend?.();
    this.disposeSend = undefined;
  }
  readonly role = input<"user" | "agent">("user");
  readonly messageId = input("");
  readonly time = input("");
  readonly author = input("Agent");
  readonly mark = input("EX");
  readonly sideChats = input(0);
  readonly pinned = input(false);
  readonly isNew = input(false);
  readonly action = output<TurnAction>();
  onKey(event: KeyboardEvent): void {
    if (
      event.target !== event.currentTarget ||
      this.role() !== "agent" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const action: TurnAction | undefined =
      event.key.toLowerCase() === "s"
        ? "side-chat"
        : event.key.toLowerCase() === "f"
          ? "fork"
          : event.key.toLowerCase() === "c"
            ? "copy"
            : undefined;
    if (action) {
      event.preventDefault();
      this.action.emit(action);
    }
  }
}
