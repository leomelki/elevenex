import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { agentLogo } from "./agent-logos";

/**
 * Bundled harness identity, sized by `--agent-mark-size`. Plain marks inherit
 * colour; tinted marks use the theme's identity palette, never status colours.
 */
@Component({
  selector: "ex-agent-mark",
  host: {
    "aria-hidden": "true",
    "[class.monogram]": "!logo()",
    "[attr.data-harness]": "logo() ? harness() : null",
    "[class.tinted]": "appearance() === 'tinted'",
  },
  templateUrl: "./agent-mark.component.html",
  styleUrl: "./agent-mark.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentMarkComponent {
  /** Monogram fallback for harnesses without a bundled logo. */
  readonly mark = input.required<string>();
  readonly harness = input<string>();
  readonly appearance = input<"plain" | "tinted">("plain");
  protected readonly logo = computed(() => agentLogo(this.harness()));
  protected readonly gradient = computed(() =>
    this.appearance() === "tinted" && this.harness() === "codex",
  );
  // SVG paint servers share the document's ID space, including across replies
  // and overlays. Each mounted mark must own its gradient reference.
  protected readonly gradientId = `agent-codex-${crypto.randomUUID()}`;
}
