import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
@Component({
  selector: "ex-switch",
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
  `,
})
export class SwitchComponent {
  readonly label = input.required<string>();
  readonly on = input(false);
  readonly disabled = input(false);
  readonly changed = output<boolean>();
}
