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
  private animation?: Animation;
  private observer?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      const content = this.element.firstElementChild;
      if (!content || typeof ResizeObserver === "undefined") return;
      let previous = content.getBoundingClientRect().height;
      this.observer = new ResizeObserver(() => {
        const next = content.getBoundingClientRect().height;
        const from = this.animation
          ? this.element.getBoundingClientRect().height
          : previous;
        previous = next;
        this.animation?.cancel();
        if (
          Math.abs(from - next) < 8 ||
          matchMedia("(prefers-reduced-motion: reduce)").matches ||
          !this.element.animate
        )
          return;
        const style = getComputedStyle(this.element);
        this.animation = this.element.animate(
          [
            { height: `${from}px`, overflow: "clip" },
            { height: `${next}px`, overflow: "clip" },
          ],
          {
            duration: parseFloat(style.getPropertyValue("--dur-base")),
            easing: style.getPropertyValue("--ease-in-out").trim(),
          },
        );
        this.animation.onfinish = () => {
          this.animation = undefined;
        };
      });
      this.observer.observe(content);
    });
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.animation?.cancel();
    });
  }
}
