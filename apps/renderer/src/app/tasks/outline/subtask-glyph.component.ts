import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";

@Component({
  selector: "ex-subtask-glyph",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "aria-hidden": "true" },
  template: `<svg
    width="16"
    height="14"
    viewBox="0 0 16 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path [attr.d]="stairs()" />
    <path [attr.d]="arrow()" />
  </svg>`,
  styles: `
    :host {
      flex: none;
      display: inline-flex;
      width: 16px;
      color: var(--ink-muted);
      transition: color var(--dur-base) var(--ease-out);
    }
    svg {
      display: block;
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        transition: none;
      }
    }
  `,
})
export class SubtaskGlyphComponent {
  readonly depth = input(1);
  private readonly level = computed(() =>
    Math.max(1, Math.min(3, Math.floor(this.depth()) || 1)),
  );
  protected readonly stairs = computed(() =>
    this.level() === 1
      ? "M3 1.5V7.5Q3 9.5 5 9.5H12.5"
      : this.level() === 2
        ? "M2.5 1.5V5H6.5V9.5H13"
        : "M2 1.5V4H5V6.75H8.5V9.5H14",
  );
  protected readonly arrow = computed(() => {
    const end = this.level() === 1 ? 12.5 : this.level() === 2 ? 13 : 14;
    return `M${end - 2.5} 7L${end} 9.5L${end - 2.5} 12`;
  });
}
