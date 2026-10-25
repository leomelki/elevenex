import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  output,
} from "@angular/core";
import { TitleBarComponent } from "../machines/title-bar.component";

/** Region layout only. The owning feature supplies navigation, chat and side views. */
@Component({
  selector: "ex-app-shell",
  imports: [TitleBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.panel-open]": "panelOpen()",
    "[class.wide-review]": "panelOpen() && wideReview()",
    "(keydown.escape)": "leaveReview()",
    "(focusin)": "rememberFocus($event)",
  },
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.css",
})
export class AppShellComponent {
  readonly panelOpen = input(false);
  readonly wideReview = input(false);
  readonly panelLabel = input("Side panel");
  readonly reviewExited = output<void>();
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private returnFocus?: HTMLElement;
  private wasOpen?: boolean;
  private wasWide?: boolean;

  constructor() {
    afterRenderEffect(() => {
      const open = this.panelOpen();
      const wide = open && this.wideReview();
      const panel = this.root.querySelector<HTMLElement>(".panel");
      const active = document.activeElement;
      if (wide && this.wasWide === false)
        panel
          ?.querySelector<HTMLElement>(
            'button:not(:disabled), [tabindex="0"], input:not(:disabled)',
          )
          ?.focus({ preventScroll: true });
      if (
        ((!open && this.wasOpen) || (!wide && this.wasWide)) &&
        (active === document.body ||
          (active instanceof Node && panel?.contains(active)))
      ) {
        if (
          this.returnFocus?.isConnected &&
          !this.returnFocus.closest("[inert]")
        )
          this.returnFocus.focus({ preventScroll: true });
      }
      this.wasOpen = open;
      this.wasWide = wide;
    });
  }

  protected rememberFocus(event: FocusEvent): void {
    if (event.target instanceof HTMLElement && !event.target.closest(".panel"))
      this.returnFocus = event.target;
  }
  protected leaveReview(): void {
    if (this.wideReview()) this.reviewExited.emit();
  }
}
