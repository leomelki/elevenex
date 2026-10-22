import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  IconComponent,
  KbdComponent,
} from "../../ui";
import type { ApprovalStatus } from "../conversation.models";
@Component({
  selector: "ex-approval-card",
  imports: [AutoHeightDirective, ButtonComponent, IconComponent, KbdComponent],
  templateUrl: "./approval-card.component.html",
  styleUrl: "./approval-card.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { tabindex: "0", "(keydown)": "onKey($event)" },
})
export class ApprovalCardComponent {
  readonly kind = input<"command" | "edit" | "tool">("command");
  readonly command = input("");
  readonly file = input("");
  readonly tool = input("");
  readonly reason = input("");
  readonly where = input("");
  readonly status = input<ApprovalStatus>("pending");
  readonly undoable = input(false);
  readonly resolve = output<Exclude<ApprovalStatus, "pending">>();
  readonly undo = output<void>();
  readonly target = computed(() =>
    this.kind() === "command"
      ? this.command()
      : this.kind() === "edit"
        ? this.file()
        : this.tool(),
  );
  onKey(event: KeyboardEvent): void {
    if (
      this.status() !== "pending" ||
      event.metaKey ||
      event.ctrlKey ||
      event.isComposing
    )
      return;
    if (event.key === "Enter") {
      event.preventDefault();
      this.resolve.emit(event.altKey ? "always" : "approved");
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.resolve.emit("denied");
    }
  }
}
