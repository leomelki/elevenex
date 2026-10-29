import {
  DestroyRef,
  effect,
  linkedSignal,
  signal,
  type Signal,
} from "@angular/core";

/** CDK owns the portal. Retain its view and readonly data through the inert exit. */
export class PopoverPresence<T> {
  readonly rendered = signal(false);
  readonly leaving = signal(false);
  readonly data: Signal<T>;
  private readonly motion = matchMedia("(prefers-reduced-motion: reduce)");
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly open: Signal<boolean>,
    readData: () => T,
    host: HTMLElement,
    destroy: DestroyRef,
  ) {
    this.data = linkedSignal<{ open: boolean; data: T }, T>({
      source: () => ({ open: this.open(), data: readData() }),
      computation: (source, previous) =>
        source.open || !previous ? source.data : previous.value,
    });
    effect(() => {
      clearTimeout(this.timer);
      if (this.open()) {
        this.rendered.set(true);
        this.leaving.set(false);
      } else if (this.rendered()) {
        this.leaving.set(true);
        if (this.motion.matches) this.finish();
        else {
          const duration =
            parseFloat(getComputedStyle(host).getPropertyValue("--dur-fast")) ||
            140;
          this.timer = setTimeout(() => this.finish(), duration + 32);
        }
      }
    });
    const reduced = () => {
      if (this.motion.matches) this.finish();
    };
    this.motion.addEventListener("change", reduced);
    destroy.onDestroy(() => {
      clearTimeout(this.timer);
      this.motion.removeEventListener("change", reduced);
    });
  }
  finish(event?: AnimationEvent): void {
    // An entry's queued end can arrive after a close has already begun.
    if (event?.animationName && !event.animationName.includes("leave")) return;
    if (this.open() || (event && event.target !== event.currentTarget)) return;
    clearTimeout(this.timer);
    this.rendered.set(false);
    this.leaving.set(false);
  }
}
