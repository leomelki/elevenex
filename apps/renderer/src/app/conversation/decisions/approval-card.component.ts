import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
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
  host: {
    tabindex: "0",
    "[attr.role]": "confirmation() ? 'group' : null",
    "[attr.aria-label]": "confirmation() ? (reason() || title()) : null",
    "(keydown)": "onKey($event)",
  },
})
export class ApprovalCardComponent {
  readonly kind = input<"command" | "edit" | "tool" | "confirmation">("command");
  readonly heading = input("");
  readonly command = input("");
  readonly file = input("");
  readonly tool = input("");
  readonly reason = input("");
  readonly where = input("");
  readonly status = input<ApprovalStatus>("pending");
  readonly undoable = input(false);
  readonly disabled = input(false);
  readonly responding = input(false);
  readonly allowAlways = input(true);
  readonly resolve = output<Exclude<ApprovalStatus, "pending">>();
  readonly undo = output<void>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly confirmation = computed(() => this.kind() === "confirmation");
  readonly canRemember = computed(() => !this.confirmation() && this.allowAlways());
  readonly title = computed(() => this.heading() || (
    this.kind() === "command" ? "Run this command?"
      : this.kind() === "edit" ? "Apply this edit?"
      : this.confirmation() ? "Confirm this request?"
      : "Allow this tool?"
  ));
  readonly target = computed(() =>
    this.kind() === "command"
      ? this.command()
      : this.kind() === "edit"
        ? this.file()
        : this.tool(),
  );
  decide(value: Exclude<ApprovalStatus, "pending">): void {
    if (this.status() !== "pending" || this.disabled() || this.responding() ||
        (value === "always" && !this.canRemember())) return;
    if (this.confirmation() && this.host.contains(this.host.ownerDocument.activeElement))
      this.host.focus({ preventScroll: true });
    this.resolve.emit(value);
  }

  onKey(event: KeyboardEvent): void {
    if (
      this.status() !== "pending" || this.disabled() || this.responding() ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.isComposing
    )
      return;
    if (event.key === "Enter") {
      // A focused button must keep its native action (especially Deny).
      if (this.confirmation() || event.target !== event.currentTarget) return;
      event.preventDefault();
      this.decide(event.altKey && this.canRemember() ? "always" : "approved");
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.decide("denied");
    }
  }
}
