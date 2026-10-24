import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  inject,
} from "@angular/core";

/** Observe a single content wrapper, never a whole repository or message list. */
@Directive({ selector: "[exAutoHeight]" })
export class AutoHeightDirective {
  private readonly element =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  private animation?: Animation;
  private observer?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      const content = this.element.firstElementChild;
      if (!content || typeof ResizeObserver === "undefined") return;
      let previous = this.element.getBoundingClientRect().height;
      this.observer = new ResizeObserver(() => {
        // A queued observation can outlive portal detachment or destruction.
        // Detached elements no longer inherit the motion tokens either.
        if (this.destroyRef.destroyed || !this.element.isConnected) return;
        const style = getComputedStyle(this.element);
        // Height belongs to the outer border box. Measuring only the inner
        // content clips padded cards and makes them jump when motion finishes.
        const next =
          content.getBoundingClientRect().height +
          [
            style.paddingTop,
            style.paddingBottom,
            style.borderTopWidth,
            style.borderBottomWidth,
          ].reduce((total, value) => total + (parseFloat(value) || 0), 0);
        const from = this.animation
          ? this.element.getBoundingClientRect().height
          : previous;
        previous = next;
        this.animation?.cancel();
        this.animation = undefined;
        if (
          Math.abs(from - next) < 8 ||
          matchMedia("(prefers-reduced-motion: reduce)").matches ||
          !this.element.animate
        )
          return;
        this.animation = this.element.animate(
          [
            { height: `${from}px`, overflow: "clip", boxSizing: "border-box" },
            { height: `${next}px`, overflow: "clip", boxSizing: "border-box" },
          ],
          {
            duration: parseFloat(style.getPropertyValue("--dur-base")),
            easing: style.getPropertyValue("--ease-out").trim(),
          },
        );
        this.animation.onfinish = () => {
          this.animation = undefined;
        };
      });
      this.observer.observe(content);
    });
    this.destroyRef.onDestroy(() => {
      this.observer?.disconnect();
      this.animation?.cancel();
    });
  }
}
