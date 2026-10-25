import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  type AnimationCallbackEvent,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from "@angular/core";

/** Keep the control mounted while outgoing ink clears before its replacement.
 * Width retargets from the painted frame, so rapid changes never restart a jump. */
@Component({
  selector: "ex-ease-swap",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./ease-swap.component.html",
  styleUrl: "./ease-swap.component.css",
})
export class EaseSwapComponent {
  readonly value = input.required<string>();
  protected readonly labels = computed(() => [{ key: this.value() }]);
  protected readonly ready = signal(false);
  private readonly element =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly text = viewChild<ElementRef<HTMLElement>>("text");
  private readonly motion =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)")
      : undefined;
  private observer?: ResizeObserver;
  private widthAnimation?: Animation;
  private readonly leaving = new Map<Animation, () => void>();
  private destroyed = false;

  constructor() {
    const settle = () => {
      if (!this.motion?.matches) return;
      this.widthAnimation?.cancel();
      this.widthAnimation = undefined;
      for (const [animation, done] of this.leaving) {
        animation.cancel();
        done();
      }
      this.leaving.clear();
    };
    this.motion?.addEventListener("change", settle);
    afterNextRender(() => {
      this.ready.set(true);
      if (typeof ResizeObserver === "undefined") return;
      // Layout sizes stay stable while an ancestor dialog or launch scales.
      // Painted rectangles would feed that outer scale back into our width.
      let width = this.element.isConnected ? parseFloat(getComputedStyle(this.element).width) || 0 : undefined;
      this.observer = new ResizeObserver(() => {
        if (this.destroyed || !this.element.isConnected) return;
        const text = this.text()?.nativeElement;
        const next = text ? parseFloat(getComputedStyle(text).width) || 0 : width ?? 0;
        if (next === width) return;
        const previous = this.widthAnimation
          ? parseFloat(getComputedStyle(this.element).width) || 0
          : width ?? next;
        width = next;
        this.widthAnimation?.cancel();
        this.widthAnimation = undefined;
        if (previous === next || !this.element.animate || this.motion?.matches) return;
        const style = getComputedStyle(this.element);
        const animation = this.element.animate(
          [{ width: `${previous}px` }, { width: `${next}px` }],
          {
            duration: parseFloat(style.getPropertyValue("--dur-slow")) || 280,
            easing:
              style.getPropertyValue("--ease-in-out").trim() || "ease-in-out",
          },
        );
        this.widthAnimation = animation;
        animation.onfinish = () => {
          if (this.widthAnimation === animation)
            this.widthAnimation = undefined;
        };
      });
      this.observer.observe(this.element);
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.observer?.disconnect();
      this.widthAnimation?.cancel();
      this.motion?.removeEventListener("change", settle);
      for (const [animation, done] of this.leaving) {
        animation.cancel();
        done();
      }
      this.leaving.clear();
    });
  }
  protected leave(event: AnimationCallbackEvent): void {
    const element = event.target;
    const style = getComputedStyle(element);
    const from = {
      opacity: style.opacity,
      transform: style.transform,
      filter: style.filter,
    };
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("inert", "");
    element.classList.add("leave");
    for (const animation of element.getAnimations?.() ?? []) animation.cancel();
    if (this.destroyed || this.motion?.matches || !element.animate) {
      event.animationComplete();
      return;
    }
    const animation = element.animate(
      [
        from,
        { opacity: 0, filter: "blur(3px)", transform: "translateY(-3px)" },
      ],
      {
        duration: 120,
        easing: style.getPropertyValue("--ease-in").trim() || "ease-in",
      },
    );
    let complete = false;
    const done = () => {
      if (!complete) {
        complete = true;
        this.leaving.delete(animation);
        event.animationComplete();
      }
    };
    this.leaving.set(animation, done);
    animation.onfinish = animation.oncancel = done;
  }
}
