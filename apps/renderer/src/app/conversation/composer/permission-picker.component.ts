import { OverlayModule } from "@angular/cdk/overlay";
import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { IconComponent } from "../../ui";
import type { PermissionLevel } from "../conversation.models";
@Component({
  selector: "ex-permission-picker",
  imports: [OverlayModule, A11yModule, IconComponent],
  templateUrl: "./permission-picker.component.html",
  styleUrl: "./picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionPickerComponent {
  readonly value = input<PermissionLevel>("ask");
  readonly changed = output<PermissionLevel>();
  readonly open = signal(false);
  readonly choices: readonly {
    id: PermissionLevel;
    label: string;
    detail: string;
  }[] = [
    { id: "ask", label: "Ask first", detail: "Approve edits and commands" },
    {
      id: "edits",
      label: "Auto-edit",
      detail: "Apply edits; ask before commands",
    },
    { id: "auto", label: "Full auto", detail: "Work within the task sandbox" },
  ];
  readonly label = computed(
    () =>
      this.choices.find((choice) => choice.id === this.value())?.label ??
      "Ask first",
  );
  select(value: PermissionLevel): void {
    this.changed.emit(value);
    this.open.set(false);
  }
}
