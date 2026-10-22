import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { IconComponent } from "../icon/icon.component";
import { TooltipDirective } from "../tooltip/tooltip.directive";

@Component({
  selector: "ex-icon-button",
  imports: [IconComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    type="button"
    [attr.aria-label]="label()"
    [exTooltip]="label()"
    [attr.aria-pressed]="active()"
    [disabled]="disabled()"
    [class.small]="size() === 'sm'"
    (click)="pressed.emit()"
  >
    <ex-icon [name]="icon()" [size]="size() === 'sm' ? 14 : 16" />
  </button>`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    button {
      font: inherit;
      width: 28px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--ink-muted);
      cursor: pointer;
      transition:
        background var(--dur-fast),
        color var(--dur-fast),
        transform var(--dur-glide) var(--ease-spring);
    }
    button:hover:not(:disabled) {
      background: var(--surface-sunken);
      color: var(--ink);
    }
    button[aria-pressed="true"] {
      background: var(--accent-soft);
      color: var(--accent);
    }
    button.small {
      width: var(--space-6);
      height: var(--space-6);
    }
    button:active:not(:disabled) {
      transform: scale(0.94);
      transition-duration: var(--dur-instant);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
  `,
})
export class IconButtonComponent {
  readonly icon = input.required<string>();
  readonly label = input.required<string>();
  readonly active = input<boolean>();
  readonly disabled = input(false);
  readonly size = input<"md" | "sm">("md");
  readonly pressed = output<void>();
}
