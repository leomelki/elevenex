import { ChangeDetectionStrategy, Component, input } from "@angular/core";

/**
 * The numbered mark for a browser element within one message. Decorative: the
 * owning control or text supplies the accessible name.
 */
@Component({
  selector: "ex-element-pin",
  template: `{{ marker() }}`,
  host: {
    "aria-hidden": "true",
    "[class.hollow]": "hollow()",
    "[class.large]": "size() === 'md'",
    "[class.danger]": "tone() === 'danger'",
  },
  styles: `
    :host {
      display: inline-grid;
      place-items: center;
      flex: none;
      width: 16px;
      height: 16px;
      border-radius: var(--radius-full);
      background: var(--accent);
      color: var(--on-accent);
      font: 600 10.5px/1 var(--font-sans);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      user-select: none;
      transition:
        background var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out),
        box-shadow var(--dur-fast) var(--ease-out);
    }
    :host(.large) {
      width: 20px;
      height: 20px;
      font-size: 12px;
    }
    /* Attached but not referenced in the prose yet. */
    :host(.hollow) {
      background: transparent;
      color: var(--accent);
      box-shadow: inset 0 0 0 1.5px var(--accent);
    }
    :host(.danger) {
      background: var(--danger);
      color: var(--surface-raised);
    }
    :host(.danger.hollow) {
      background: transparent;
      color: var(--danger);
      box-shadow: inset 0 0 0 1.5px var(--danger);
    }
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementPinComponent {
  readonly marker = input.required<number>();
  readonly hollow = input(false);
  readonly size = input<"sm" | "md">("sm");
  readonly tone = input<"accent" | "danger">("accent");
}
