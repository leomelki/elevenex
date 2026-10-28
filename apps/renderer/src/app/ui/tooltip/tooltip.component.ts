import { ChangeDetectionStrategy, Component, input } from "@angular/core";
@Component({
  selector: "ex-tooltip",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: "tooltip", "[id]": "tooltipId()" },
  template: `{{ label() }}
    @if (kbd()) {
      <span>{{ kbd() }}</span>
    }`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--ink);
      color: var(--ink-inverse);
      font-size: var(--text-caption-size);
      line-height: var(--text-caption-line);
      font-weight: 500;
      max-width: min(64ch, calc(100vw - var(--space-8)));
      white-space: normal;
      overflow-wrap: anywhere;
      box-shadow: var(--shadow-pop);
      pointer-events: none;
      animation: appear var(--dur-fast) var(--ease-out);
    }
    span {
      font-family: var(--font-mono);
      opacity: 0.8;
    }
    @keyframes appear {
      from {
        opacity: 0;
        transform: translateY(2px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
      }
    }
  `,
})
export class TooltipComponent {
  readonly label = input.required<string>();
  readonly kbd = input("");
  readonly tooltipId = input("");
}
