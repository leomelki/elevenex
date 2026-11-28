import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { SegmentedComponent, type SegmentOption } from "../../ui";
import type { ConversationMode } from "../conversation.models";
@Component({
  selector: "ex-mode-toggle",
  imports: [SegmentedComponent],
  template: `<ex-segmented
    label="Agent mode"
    size="sm"
    [options]="options()"
    [value]="value()"
    (changed)="select($event)"
  />`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModeToggleComponent {
  readonly value = input<ConversationMode>("code");
  readonly disabled = input(false);
  readonly changed = output<ConversationMode>();
  readonly options = computed<readonly SegmentOption[]>(() => [
    {
      id: "plan",
      label: "Plan",
      icon: "plan",
      title: "Plan · Shift Tab",
      disabled: this.disabled(),
    },
    {
      id: "code",
      label: "Code",
      icon: "code",
      title: "Code · Shift Tab",
      disabled: this.disabled(),
    },
  ]);
  select(value: string): void {
    if (!this.disabled() && (value === "plan" || value === "code"))
      this.changed.emit(value);
  }
}
