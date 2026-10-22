import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { IconComponent } from "../../ui";
import type { ConversationMode } from "../conversation.models";
@Component({
  selector: "ex-mode-toggle",
  imports: [IconComponent],
  template: `<div role="group" aria-label="Agent mode">
    <button
      type="button"
      [attr.aria-pressed]="value() === 'plan'"
      (click)="changed.emit('plan')"
      title="Plan · Shift Tab"
    >
      <ex-icon name="plan" [size]="13" />Plan</button
    ><button
      type="button"
      [attr.aria-pressed]="value() === 'code'"
      (click)="changed.emit('code')"
      title="Code · Shift Tab"
    >
      <ex-icon name="code" [size]="13" />Code
    </button>
  </div>`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    div {
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: var(--radius-sm);
      background: var(--surface-sunken);
    }
    button {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      height: 26px;
      padding: 0 var(--space-2);
      border: 0;
      border-radius: var(--radius-xs);
      background: transparent;
      color: var(--ink-muted);
      font: inherit;
      font-size: var(--text-caption-size);
      cursor: pointer;
      transition:
        background-color var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out);
    }
    button[aria-pressed="true"] {
      background: var(--surface-raised);
      box-shadow: var(--shadow-raised);
      color: var(--ink);
    }
    button:focus-visible {
      outline: 2px solid transparent;
      box-shadow: var(--focus-ring);
    }
    @media (prefers-reduced-motion: reduce) {
      button {
        transition: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModeToggleComponent {
  readonly value = input<ConversationMode>("code");
  readonly changed = output<ConversationMode>();
}
