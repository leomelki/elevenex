import { OverlayModule } from "@angular/cdk/overlay";
import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  afterRenderEffect,
  input,
  output,
  signal,
} from "@angular/core";
import { IconComponent } from "../../ui";
import type { PermissionChoice } from "../conversation.models";
@Component({
  selector: "ex-permission-picker",
  imports: [OverlayModule, A11yModule, IconComponent],
  templateUrl: "./permission-picker.component.html",
  styleUrl: "./picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionPickerComponent {
  readonly value = input<string>("ask");
  readonly disabled = input(false);
  readonly changed = output<string>();
  readonly open = signal(false);
  readonly choices = input<readonly PermissionChoice[]>([
    { id: "ask", label: "Ask first", detail: "Approve edits and commands" },
    {
      id: "edits",
      label: "Auto-edit",
      detail: "Apply edits; ask before commands",
    },
    { id: "auto", label: "Full auto", detail: "Work within the task sandbox" },
  ]);
  readonly label = computed(
    () =>
      this.choices().find((choice) => choice.id === this.value())?.label ??
      this.value(),
  );
  constructor() {
    afterRenderEffect(() => {
      if (this.disabled()) this.open.set(false);
    });
  }
  select(value: string): void {
    if (
      this.disabled() ||
      !this.choices().some((choice) => choice.id === value)
    )
      return;
    this.changed.emit(value);
    this.open.set(false);
  }
}
