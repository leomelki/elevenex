import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
@Component({
  selector: "ex-skeleton",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "aria-busy": "true",
    "aria-label": "Loading",
    "[class.message]": 'variant() === "message"',
  },
  template: `@for (row of rows(); track $index) {
    <div class="row" aria-hidden="true">
      @if (variant() === "rows") {
        <i class="mark"></i>
      }
      <i class="line" [style.width.%]="52 + (($index * 17) % 38)"></i>
    </div>
  }`,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      animation: reveal 1ms linear 150ms both;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      height: var(--row-height);
      padding-inline: var(--space-2);
    }
    .mark {
      width: 14px;
      height: 14px;
      border-radius: var(--radius-full);
    }
    .line {
      height: 10px;
      border-radius: var(--radius-xs);
    }
    i {
      display: block;
      background: linear-gradient(
        90deg,
        var(--surface-sunken) 35%,
        var(--line) 50%,
        var(--surface-sunken) 65%
      );
      background-size: 250% 100%;
      animation: shimmer 1.4s linear infinite;
    }
    :host(.message) .row {
      height: var(--space-4);
    }
    @keyframes reveal {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    @keyframes shimmer {
      to {
        background-position: -250% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      i {
        animation: none;
      }
    }
  `,
})
export class SkeletonComponent {
  readonly variant = input<"rows" | "message">("rows");
  readonly count = input(3);
  protected readonly rows = computed(() =>
    Array.from({
      length: Math.max(0, Math.min(100, Math.floor(this.count()))),
    }),
  );
}
