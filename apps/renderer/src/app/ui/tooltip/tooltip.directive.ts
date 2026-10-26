import { AriaDescriber } from "@angular/cdk/a11y";
import { Overlay, OverlayRef } from "@angular/cdk/overlay";
import { ComponentPortal } from "@angular/cdk/portal";
import {
  DestroyRef,
  Directive,
  ElementRef,
  Injectable,
  inject,
  input,
} from "@angular/core";
import { TooltipComponent } from "./tooltip.component";

/** Shared hover grace belongs to this renderer, rather than module mutable state. */
@Injectable({ providedIn: "root" })
export class TooltipTiming {
  lastClosed = 0;
}

@Directive({
  selector: "[exTooltip]",
  host: {
    "(mouseenter)": "schedule(false)",
    "(mouseleave)": "hide()",
    "(focusin)": "schedule(true)",
    "(focusout)": "hide()",
    "(keydown.escape)": "hide()",
    "(click)": "hide()",
  },
})
export class TooltipDirective {
  readonly exTooltip = input.required<string>();
  readonly tooltipShortcut = input("");
  readonly tooltipSide = input<"top" | "bottom">("top");
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly describer = inject(AriaDescriber);
  private readonly timing = inject(TooltipTiming);
  private popup?: OverlayRef;
  private timer?: ReturnType<typeof setTimeout>;
  private described = "";

  constructor() {
    inject(DestroyRef).onDestroy(() => this.hide());
  }

  protected schedule(focused: boolean): void {
    this.hide();
    if (!this.exTooltip()) return;
    const delay =
      focused || Date.now() - this.timing.lastClosed < 600 ? 0 : 400;
    this.timer = setTimeout(() => this.show(), delay);
  }

  private show(): void {
    const top = this.tooltipSide() === "top";
    const position = this.overlay
      .position()
      .flexibleConnectedTo(this.element)
      .withPositions([
        {
          originX: "center",
          originY: top ? "top" : "bottom",
          overlayX: "center",
          overlayY: top ? "bottom" : "top",
          offsetY: top ? -8 : 8,
        },
        {
          originX: "center",
          originY: top ? "bottom" : "top",
          overlayX: "center",
          overlayY: top ? "top" : "bottom",
          offsetY: top ? 8 : -8,
        },
      ]);
    this.popup = this.overlay.create({
      positionStrategy: position,
      scrollStrategy: this.overlay.scrollStrategies.close(),
    });
    const component = this.popup.attach(new ComponentPortal(TooltipComponent));
    component.setInput("label", this.exTooltip());
    component.setInput("kbd", this.tooltipShortcut());
    this.described = this.exTooltip();
    this.describer.describe(this.element.nativeElement, this.described);
  }

  protected hide(): void {
    clearTimeout(this.timer);
    if (this.popup) {
      this.popup.dispose();
      this.popup = undefined;
      this.timing.lastClosed = Date.now();
    }
    if (this.described) {
      this.describer.removeDescription(
        this.element.nativeElement,
        this.described,
      );
      this.described = "";
    }
  }
}
