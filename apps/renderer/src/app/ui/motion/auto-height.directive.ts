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
      // Projected content can be created before its portal is attached. Its
      // first visible size is a baseline, not a content change from zero.
      let previous = this.element.isConnected
        ? this.element.offsetHeight || this.element.getBoundingClientRect().height
        : undefined;
      this.observer = new ResizeObserver(() => {
        // A queued observation can outlive portal detachment or destruction.
        // Detached elements no longer inherit the motion tokens either.
        if (this.destroyRef.destroyed) return;
        if (!this.element.isConnected) {
          // Portals can reuse the same view with different content. A detached
          // view has no painted height to animate from on its next attachment.
          this.animation?.cancel();
          this.animation = undefined;
          previous = undefined;
          return;
        }
        const style = getComputedStyle(this.element);
        const painted = this.element.getBoundingClientRect().height;
        const scale = (this.element.offsetHeight ? painted / this.element.offsetHeight : 1) || 1;
        // Height belongs to the outer border box. Measuring only the inner
        // content clips padded cards and makes them jump when motion finishes.
        const next =
          content.getBoundingClientRect().height / scale +
          [
            style.paddingTop,
            style.paddingBottom,
            style.borderTopWidth,
            style.borderBottomWidth,
          ].reduce((total, value) => total + (parseFloat(value) || 0), 0);
        const from = this.animation
          ? painted / scale
          : previous ?? next;
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
