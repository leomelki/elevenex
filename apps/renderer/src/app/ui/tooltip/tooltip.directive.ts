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
import type { Subscription } from "rxjs";
import { TooltipComponent } from "./tooltip.component";

/** Shared hover grace belongs to this renderer, rather than module mutable state. */
@Injectable({ providedIn: "root" })
export class TooltipTiming {
  lastClosed = 0;
  private active?: () => void;

  activate(close: () => void): void {
    this.active?.();
    this.active = close;
  }

  release(close: () => void): void {
    if (this.active === close) this.active = undefined;
  }
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
  /** `end` suits vertical stacks such as a rail, where above would cover a neighbour. */
  readonly tooltipSide = input<"top" | "bottom" | "end">("top");
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly describer = inject(AriaDescriber);
  private readonly timing = inject(TooltipTiming);
  private popup?: OverlayRef;
  private detachment?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private described = "";
  private readonly closeActive = () => this.hide();

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
    // Hovering another control replaces a tooltip retained by keyboard focus.
    this.timing.activate(this.closeActive);
    const top = this.tooltipSide() === "top";
    const position = this.overlay
      .position()
      .flexibleConnectedTo(this.element)
      .withPositions(
        this.tooltipSide() === "end"
          ? [
              {
                originX: "end",
                originY: "center",
                overlayX: "start",
                overlayY: "center",
                offsetX: 8,
              },
              {
                originX: "start",
                originY: "center",
                overlayX: "end",
                overlayY: "center",
                offsetX: -8,
              },
            ]
          : [
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
            ],
      );
    this.popup = this.overlay.create({
      positionStrategy: position,
      scrollStrategy: this.overlay.scrollStrategies.close(),
    });
    this.detachment = this.popup.detachments().subscribe(() => this.hide());
    const component = this.popup.attach(new ComponentPortal(TooltipComponent));
    // CDK restores pane hit testing on attach. The tooltip is decorative, so
    // keep its entire overlay transparent to the page below it afterward.
    this.popup.overlayElement.style.pointerEvents = 'none';
    component.setInput("label", this.exTooltip());
    component.setInput("kbd", this.tooltipShortcut());
    this.described = this.exTooltip();
    this.describer.describe(this.element.nativeElement, this.described);
    this.follow();
  }

  /**
   * CDK repositions only on scroll and resize. An anchor inside a surface that
   * eases its size (a menu growing upward) moves on its own: keep the tooltip on
   * it while shown, with one rect read per frame.
   */
  private follow(): void {
    const anchor = this.element.nativeElement;
    let last = anchor.getBoundingClientRect();
    const tick = () => {
      if (!this.popup?.hasAttached()) return;
      const rect = anchor.getBoundingClientRect();
      if (rect.top !== last.top || rect.left !== last.left) {
        last = rect;
        this.popup?.updatePosition();
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  protected hide(): void {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.detachment?.unsubscribe();
    this.detachment = undefined;
    this.timing.release(this.closeActive);
    const popup = this.popup;
    this.popup = undefined;
    if (popup) {
      popup.dispose();
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
