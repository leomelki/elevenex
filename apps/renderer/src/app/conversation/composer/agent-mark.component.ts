import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { agentLogo } from "./agent-logos";

/**
 * A harness's brand mark in `currentColor`, sized by the host (`--agent-mark-size`).
 * Harnesses without a bundled logo keep the neutral two-letter monogram.
 */
@Component({
  selector: "ex-agent-mark",
  host: {
    "aria-hidden": "true",
    "[class.monogram]": "!logo()",
  },
  template: `
    @if (logo(); as logo) {
      <svg [attr.viewBox]="logo.viewBox" fill="currentColor" fill-rule="evenodd">
        @for (path of logo.paths; track $index) {
          <path [attr.d]="path" />
        }
      </svg>
    } @else {
      {{ mark() }}
    }
  `,
  styles: `
    :host {
      --agent-mark-size: var(--space-4);
      flex: none;
      display: grid;
      place-items: center;
      width: var(--agent-mark-size);
      height: var(--agent-mark-size);
    }
    svg {
      display: block;
      width: 86%;
      height: 86%;
    }
    :host(.monogram) {
      border-radius: calc(var(--radius-xs) + 1px);
      background: var(--accent-soft);
      color: var(--accent);
      font: 700 calc(var(--agent-mark-size) / 2) / 1 var(--font-sans);
      letter-spacing: var(--text-display-tracking);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentMarkComponent {
  /** Monogram fallback for harnesses without a bundled logo. */
  readonly mark = input.required<string>();
  readonly harness = input<string>();
  protected readonly logo = computed(() => agentLogo(this.harness()));
}
