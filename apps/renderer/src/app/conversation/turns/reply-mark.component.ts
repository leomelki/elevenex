import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { AgentMarkComponent } from "../composer/agent-mark.component";

/**
 * The agent's identity in a reply's 28px gutter, shared by `Turn` and agent
 * `Message`s. AgentMark owns the tinted identity tile; the owning turn animates
 * the live ring on this host so status stays independent of brand colour.
 */
@Component({
  selector: "ex-reply-mark",
  imports: [AgentMarkComponent],
  host: {
    role: "img",
    "[attr.aria-label]": "author()",
    "[title]": "tooltip()",
  },
  template: `<ex-agent-mark appearance="tinted" [harness]="harness()" [mark]="mark()" />`,
  styles: `
    :host {
      box-sizing: border-box;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: var(--radius-sm);
      user-select: none;
    }
    ex-agent-mark {
      --agent-mark-size: 28px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReplyMarkComponent {
  /** Accessible name and tooltip, e.g. "Claude Code". */
  readonly author = input.required<string>();
  /** Monogram fallback for missing or unknown harnesses. */
  readonly mark = input.required<string>();
  /** Exact harness ID for a bundled logo. */
  readonly harness = input<string>();
  readonly time = input("");
  protected readonly tooltip = computed(() =>
    this.time() ? `${this.author()} · ${this.time()}` : this.author(),
  );
}
