import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
@Component({
  selector: "ex-switch",
  host: { "[attr.data-size]": "size()" },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    type="button"
    role="switch"
    [attr.aria-checked]="on()"
    [attr.aria-label]="label()"
    [disabled]="disabled()"
    (click)="changed.emit(!on())"
  >
    <span></span>
  </button>`,
  styles: `
    :host {
      display: inline-flex;
    }
    button {
      width: 30px;
      height: 18px;
      padding: 2px;
      border: 0;
      border-radius: var(--radius-full);
      background: var(--line-strong);
      cursor: pointer;
      transition: background var(--dur-fast);
    }
    span {
      display: block;
      width: 14px;
      height: 14px;
      border-radius: var(--radius-full);
      background: var(--surface-raised);
      transition: transform var(--dur-fast) var(--ease-in-out);
    }
    [aria-checked="true"] {
      background: var(--accent);
    }
    [aria-checked="true"] span {
      transform: translateX(12px);
      background: var(--on-accent);
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    :host([data-size="sm"]) button {
      width: 28px;
      height: 16px;
    }
    :host([data-size="sm"]) span {
      width: 12px;
      height: 12px;
      box-shadow: var(--shadow-raised);
      transition:
        transform var(--dur-glide) var(--ease-glide),
        width var(--dur-fast) var(--ease-out);
    }
    :host([data-size="sm"]) [aria-checked="true"] span {
      background: var(--surface-raised);
    }
    :host([data-size="sm"]) button:active:not(:disabled) span {
      width: 15px;
    }
    :host([data-size="sm"]) [aria-checked="true"]:active:not(:disabled) span {
      transform: translateX(9px);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    @media (prefers-reduced-motion: reduce) {
      button,
      span {
        transition: none !important;
      }
    }
  `,
})
export class SwitchComponent {
  readonly size = input<"md" | "sm">("md");
  readonly label = input.required<string>();
  readonly on = input(false);
  readonly disabled = input(false);
  readonly changed = output<boolean>();
}
