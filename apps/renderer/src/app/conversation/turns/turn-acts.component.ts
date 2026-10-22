import { ChangeDetectionStrategy, Component, output } from "@angular/core";
import { IconButtonComponent } from "../../ui";
import type { TurnAction } from "../conversation.models";
@Component({
  selector: "ex-turn-acts",
  imports: [IconButtonComponent],
  template: `<ex-icon-button
      icon="side-chat"
      label="Side chat (S)"
      size="sm"
      (pressed)="action.emit('side-chat')"
    /><ex-icon-button
      icon="fork"
      label="Fork from here (F)"
      size="sm"
      (pressed)="action.emit('fork')"
    /><ex-icon-button
      icon="copy"
      label="Copy reply (C)"
      size="sm"
      (pressed)="action.emit('copy')"
    />`,
  styles: `
    :host {
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurnActsComponent {
  readonly action = output<TurnAction>();
}
