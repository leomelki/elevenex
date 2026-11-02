import { ChangeDetectionStrategy, Component, input } from "@angular/core";

/** Neutral harness monogram, matching the rendered standalone reference. */
@Component({
  selector: "ex-agent-mark",
  host: { "aria-hidden": "true" },
  template: "{{ mark() }}",
  styles: `
    :host {
      flex: none;
      display: grid;
      place-items: center;
      width: var(--space-4);
      height: var(--space-4);
      border-radius: calc(var(--radius-xs) + 1px);
      background: var(--accent-soft);
      color: var(--accent);
      font: 700 8px/var(--text-ui-line) var(--font-sans);
      letter-spacing: var(--text-display-tracking);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentMarkComponent {
  readonly mark = input.required<string>();
}
