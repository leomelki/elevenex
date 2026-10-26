import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from "@angular/core";
import { Status, STATUS_LABELS } from "./status.models";

@Component({
  selector: "ex-status-glyph",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./status-glyph.component.html",
  styleUrl: "./status-glyph.component.css",
})
export class StatusGlyphComponent {
  readonly status = input<Status>("queued");
  readonly size = input(14);
  protected readonly labels = STATUS_LABELS;
  private previous?: Status;
  private readonly animations = new Set<Animation>();
  private readonly element =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterRenderEffect(() => {
      const status = this.status();
      const previous = this.previous;
      this.previous = status;
      for (const animation of this.animations) animation.cancel();
      this.animations.clear();
      if (
        !previous ||
        previous === status ||
        !this.element.animate ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const style = getComputedStyle(this.element);
      if (
        previous === "running" &&
        (status === "done" || status === "review")
      ) {
        this.play(
          this.element.querySelector(".burst"),
          [
            { opacity: 0.7, transform: "scale(.8)" },
            { opacity: 0, transform: "scale(1.6)" },
          ],
          {
            duration: parseFloat(style.getPropertyValue("--dur-slow")),
            easing: style.getPropertyValue("--ease-out").trim(),
          },
        );
        this.play(
          this.element.querySelector(".check"),
          [
            { strokeDasharray: "1", strokeDashoffset: "1" },
            { strokeDasharray: "1", strokeDashoffset: "0" },
          ],
          {
            duration: parseFloat(style.getPropertyValue("--dur-deliberate")),
            easing: style.getPropertyValue("--ease-out").trim(),
          },
        );
        return;
      }
      const frames =
        status === "failed"
          ? [
              { transform: "translateX(-2px)" },
              { transform: "translateX(2px)" },
              { transform: "none" },
            ]
          : status === "attention"
            ? [
                { transform: "scale(.8)" },
                { transform: "scale(1.1)" },
                { transform: "none" },
              ]
            : [
                { opacity: 0.35, transform: "rotate(-45deg) scale(.9)" },
                { opacity: 1, transform: "none" },
              ];
      this.play(this.element, frames, {
        duration: parseFloat(style.getPropertyValue("--dur-deliberate")),
        easing: style.getPropertyValue("--ease-spring").trim(),
      });
    });
    inject(DestroyRef).onDestroy(() => {
      for (const animation of this.animations) animation.cancel();
    });
  }

  private play(
    target: Element | null,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): void {
    if (!target?.animate) return;
    const animation = target.animate(frames, options);
    this.animations.add(animation);
    animation.onfinish = animation.oncancel = () =>
      this.animations.delete(animation);
  }
}
