import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  inject,
  input,
  output,
  signal,
  viewChildren,
} from "@angular/core";
import { IconComponent } from "../icon/icon.component";

export interface SegmentOption {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly title?: string;
  readonly disabled?: boolean;
}
@Component({
  selector: "ex-segmented",
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./segmented.component.html",
  styleUrl: "./segmented.component.css",
})
export class SegmentedComponent {
  readonly options = input.required<readonly SegmentOption[]>();
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly size = input<"md" | "sm">("md");
  readonly changed = output<string>();
  private readonly buttons =
    viewChildren<ElementRef<HTMLButtonElement>>("option");
  protected readonly thumb = signal<{
    readonly left: number;
    readonly width: number;
  } | null>(null);
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private observer?: ResizeObserver;

  constructor() {
    const measure = () => {
      const selected = this.root.querySelector<HTMLElement>(
        '[aria-checked="true"]',
      );
      this.thumb.set(
        selected
          ? { left: selected.offsetLeft, width: selected.offsetWidth }
          : null,
      );
    };
    afterRenderEffect(() => {
      this.value();
      this.options();
      this.size();
      measure();
    });
    afterNextRender(() => {
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(measure);
        this.observer.observe(this.root);
      }
    });
    inject(DestroyRef).onDestroy(() => this.observer?.disconnect());
  }

  protected keydown(event: KeyboardEvent, index: number): void {
    const options = this.options();
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    let next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (index + direction + options.length) % options.length;
    for (let count = 0; count < options.length; count++) {
      const option = options[next];
      if (option && !option.disabled) {
        this.changed.emit(option.id);
        this.buttons()[next]?.nativeElement.focus();
        return;
      }
      next =
        (next +
          (direction || (event.key === "End" ? -1 : 1)) +
          options.length) %
        options.length;
    }
  }
}
