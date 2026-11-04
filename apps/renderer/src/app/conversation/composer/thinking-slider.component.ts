import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from "@angular/core";
import { thinkingLabel } from "./agent-config";

/**
 * Thinking level as one stepped track, from faster to smarter. A native range
 * keeps keyboard, pointer and assistive behavior. Dragging previews the level;
 * a level is emitted once it is committed, never for every intermediate step.
 */
@Component({
  selector: "ex-thinking-slider",
  templateUrl: "./thinking-slider.component.html",
  styleUrl: "./thinking-slider.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThinkingSliderComponent {
  /** Provider-ordered levels, from least to most reasoning. */
  readonly levels = input.required<readonly string[]>();
  readonly value = input<string>();
  readonly disabled = input(false);
  readonly changed = output<string>();
  protected readonly id = `thinking-${crypto.randomUUID()}`;
  private readonly selected = computed(() =>
    this.levels().indexOf(this.value() ?? ""),
  );
  /**
   * The thumb follows a drag and keeps a committed level while the owner applies
   * it. A new value, or the end of an update (`disabled` settling), re-syncs it,
   * so a rejected change returns to the actual level.
   */
  protected readonly shown = linkedSignal({
    source: () => ({ selected: this.selected(), disabled: this.disabled() }),
    computation: ({ selected }) => selected,
  });
  protected readonly unset = computed(() => this.shown() < 0);
  protected readonly label = computed(() => {
    const level = this.levels()[this.shown()];
    return level ? thinkingLabel(level) : "Default";
  });
  protected readonly last = computed(() => Math.max(1, this.levels().length - 1));
  protected readonly fraction = computed(
    () => Math.max(0, this.shown()) / this.last(),
  );
  protected readonly ticks = computed(() =>
    this.levels().map((level, index) => ({
      level,
      at: index / this.last(),
    })),
  );

  protected preview(event: Event): void {
    this.shown.set(Number((event.target as HTMLInputElement).value));
  }
  protected commit(event: Event): void {
    const level = this.levels()[Number((event.target as HTMLInputElement).value)];
    if (level && !this.disabled() && level !== this.value())
      this.changed.emit(level);
  }
}
