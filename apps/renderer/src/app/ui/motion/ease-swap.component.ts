import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from "@angular/core";

/** Keep the control mounted while its text crossfades and its width eases. */
@Component({
  selector: "ex-ease-swap",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (label of [value()]; track label) {
    <span
      #text
      [animate.enter]="ready() ? 'enter' : ''"
      animate.leave="leave"
      >{{ label }}</span
    >
  }`,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
      vertical-align: middle;
      white-space: nowrap;
    }
    span {
      display: inline-block;
    }
    .enter {
      animation: fade-in var(--dur-base) var(--ease-out);
    }
    .leave {
      position: absolute;
      inset-inline-start: 0;
      animation: fade-out var(--dur-fast) var(--ease-in);
      pointer-events: none;
    }
    @keyframes fade-in {
      from {
        opacity: 0;
      }
    }
    @keyframes fade-out {
      to {
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .enter,
      .leave {
        animation: none;
      }
    }
  `,
})
export class EaseSwapComponent {
  readonly value = input.required<string>();
  protected readonly ready = signal(false);
  private readonly element =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly text = viewChild<ElementRef<HTMLElement>>("text");
  private observer?: ResizeObserver;
  private animation?: Animation;

  constructor() {
    afterNextRender(() => {
      this.ready.set(true);
      if (typeof ResizeObserver === "undefined") return;
      let width = this.element.getBoundingClientRect().width;
      this.observer = new ResizeObserver(() => {
        const next =
          this.text()?.nativeElement.getBoundingClientRect().width ?? width;
        const previous = this.animation
          ? this.element.getBoundingClientRect().width
          : width;
        if (next === width) return;
        width = next;
        this.animation?.cancel();
        if (
          !this.element.animate ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
        )
          return;
        const style = getComputedStyle(this.element);
        this.animation = this.element.animate(
          [{ width: `${previous}px` }, { width: `${next}px` }],
          {
            duration: parseFloat(style.getPropertyValue("--dur-base")),
            easing: style.getPropertyValue("--ease-in-out").trim(),
          },
        );
        this.animation.onfinish = () => {
          this.animation = undefined;
        };
      });
      this.observer.observe(this.element);
    });
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.animation?.cancel();
    });
  }
}
