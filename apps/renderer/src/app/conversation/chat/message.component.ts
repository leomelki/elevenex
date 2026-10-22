import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import type { TurnAction } from "../conversation.models";
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
