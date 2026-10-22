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
  private animation?: Animation;
  private readonly element =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterRenderEffect(() => {
      const status = this.status();
      const previous = this.previous;
      this.previous = status;
      this.animation?.cancel();
      if (
        !previous ||
        previous === status ||
        !this.element.animate ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const style = getComputedStyle(this.element);
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
                { opacity: 0.35, transform: "scale(.9)" },
                { opacity: 1, transform: "none" },
              ];
      this.animation = this.element.animate(frames, {
        duration: parseFloat(style.getPropertyValue("--dur-deliberate")),
        easing: style.getPropertyValue("--ease-spring").trim(),
      });
    });
    inject(DestroyRef).onDestroy(() => this.animation?.cancel());
  }
}
