import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
@Component({
  selector: "ex-context-meter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[attr.data-tone]":
      'fraction() >= .9 ? "danger" : fraction() >= .75 ? "attention" : "normal"',
    "[attr.title]": "description()",
    role: "img",
    "[attr.aria-label]": "description()",
  },
  template: `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="5.25"
        fill="none"
        stroke="currentColor"
        stroke-opacity=".22"
        stroke-width="1.75"
      />
      <circle
        class="arc"
        cx="7"
        cy="7"
        r="5.25"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-dasharray="32.987"
        [attr.stroke-dashoffset]="32.987 * (1 - fraction())"
        transform="rotate(-90 7 7)"
      />
    </svg>
    @if (!compact()) {
      <span>{{ percent() }}%</span>
    }`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      color: var(--ink-muted);
      font: var(--text-mono-meta-size)/var(--text-mono-meta-line)
        var(--font-mono);
    }
    :host([data-tone="attention"]) {
      color: var(--attention);
    }
    :host([data-tone="danger"]) {
      color: var(--danger);
    }
    .arc {
      transition: stroke-dashoffset var(--dur-slow) var(--ease-in-out);
    }
  `,
})
export class ContextMeterComponent {
  readonly used = input(0);
  readonly tokens = input("");
  readonly compact = input(false);
  protected readonly fraction = computed(() =>
    Math.max(0, Math.min(1, Number.isFinite(this.used()) ? this.used() : 0)),
  );
  protected readonly percent = computed(() =>
    Math.round(this.fraction() * 100),
  );
  protected readonly description = computed(
    () =>
      `Context ${this.percent()}% used${this.tokens() ? ` · ${this.tokens()}` : ""}`,
  );
}
