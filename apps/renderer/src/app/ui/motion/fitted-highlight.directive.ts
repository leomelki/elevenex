import {
  DestroyRef,
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from "@angular/core";

interface HighlightBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One measured selection surface. Selection changes glide; layout changes fit
 * immediately, so a folding/resizing list never leaves the highlight behind. */
@Directive({ selector: "[exFittedHighlight]" })
export class FittedHighlightDirective {
  readonly exFittedHighlight = input.required<string>();
  /** Include selection and supplied-row identities when either can change. */
  readonly highlightKey = input<string | number>("");
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly media = matchMedia("(prefers-reduced-motion: reduce)");
  private thumb?: HTMLSpanElement;
  private observer?: ResizeObserver;
  private selected?: HTMLElement;
  private animation?: Animation;
  private box?: HighlightBox;

  constructor() {
    const reduce = () => {
      if (this.media.matches) {
        this.animation?.cancel();
        this.animation = undefined;
        this.measure(false);
      }
    };
    this.media.addEventListener("change", reduce);
    afterRenderEffect(() => {
      this.highlightKey();
      this.exFittedHighlight();
      if (!this.thumb) {
        this.thumb = this.root.ownerDocument.createElement("span");
        this.thumb.className = "ex-fitted-highlight";
        this.thumb.setAttribute("aria-hidden", "true");
        Object.assign(this.thumb.style, {
          position: "absolute",
          top: "0",
          left: "0",
          borderRadius: "var(--highlight-radius, var(--radius-sm))",
          background: "var(--highlight-background, var(--surface-raised))",
          boxShadow: "var(--highlight-shadow, var(--shadow-raised))",
          pointerEvents: "none",
          zIndex: "0",
        });
        this.root.prepend(this.thumb);
        this.root.classList.add("has-fitted-highlight");
        if (typeof ResizeObserver !== "undefined") {
          this.observer = new ResizeObserver(() => this.measure(false));
          this.observer.observe(this.root);
        }
      }
      this.measure(true);
    });
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.animation?.cancel();
      this.media.removeEventListener("change", reduce);
      this.thumb?.remove();
      this.root.classList.remove("has-fitted-highlight");
    });
  }
  private measure(glide: boolean): void {
    const thumb = this.thumb;
    if (!thumb) return;
    const selected = this.root.querySelector<HTMLElement>(
      this.exFittedHighlight(),
    );
    if (selected !== this.selected) {
      if (this.selected) this.observer?.unobserve(this.selected);
      this.selected = selected ?? undefined;
      if (selected) this.observer?.observe(selected);
    }
    if (!selected) {
      this.animation?.cancel();
      this.animation = undefined;
      thumb.style.opacity = "0";
      this.box = undefined;
      return;
    }
    const next = {
      left: selected.offsetLeft,
      top: selected.offsetTop,
      width: selected.offsetWidth,
      height: selected.offsetHeight,
    };
    const before = this.box;
    if (
      before &&
      next.left === before.left &&
      next.top === before.top &&
      next.width === before.width &&
      next.height === before.height
    )
      return;
    // Capture the current painted frame before cancelling an interrupted glide.
    const current = thumb.getBoundingClientRect();
    const container = this.root.getBoundingClientRect();
    const from = this.animation
      ? {
          left: current.left - container.left + this.root.scrollLeft,
          top: current.top - container.top + this.root.scrollTop,
          width: current.width,
          height: current.height,
        }
      : before;
    this.animation?.cancel();
    this.animation = undefined;
    this.box = next;
    const frame = (box: HighlightBox) => ({
      transform: `translate(${box.left}px, ${box.top}px)`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    Object.assign(thumb.style, frame(next), { opacity: "1" });
    if (!glide || !from || this.media.matches || !thumb.animate) return;
    const style = getComputedStyle(this.root);
    const animation = thumb.animate([frame(from), frame(next)], {
      duration: parseFloat(style.getPropertyValue("--dur-glide")) || 340,
      easing: style.getPropertyValue("--ease-glide").trim() || "ease-out",
    });
    this.animation = animation;
    animation.onfinish = () => {
      if (this.animation === animation) this.animation = undefined;
    };
  }
}
