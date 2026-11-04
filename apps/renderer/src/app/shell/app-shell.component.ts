import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  signal,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  output,
  untracked,
} from "@angular/core";
import { TitleBarComponent } from "../machines/title-bar.component";

/** Region layout only. The owning feature supplies navigation, chat and side views. */
@Component({
  selector: "ex-app-shell",
  imports: [TitleBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.embedded]": "!titleBar()",
    "[class.panel-open]": "panelOpen()",
    "[class.panel-retained]": "panelPresent()",
    "[class.wide-review]": "takingOver()",
    "(keydown.escape)": "leaveReview()",
    "(focusin)": "rememberFocus($event)",
  },
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.css",
})
export class AppShellComponent {
  /** MachineApp owns native chrome; standalone compositions include it here. */
  readonly titleBar = input(true);
  readonly panelOpen = input(false);
  private readonly retainedPanel = signal(false);
  private readonly retainedWide = signal(false);
  /** Visual lifetime only; closed contents are already inert during their exit. */
  readonly panelPresent = computed(() => this.panelOpen() || this.retainedPanel());
  readonly wideReview = input(false);
  /** Keep the outgoing feature layout until its closing picture is gone. */
  readonly panelWide = computed(() => !this.panelOpen() && this.retainedPanel() ? this.retainedWide() : this.wideReview());
  readonly panelLabel = input("Side panel");
  readonly reviewExited = output<void>();
  readonly panelCloseRequested = output<void>();
  private readonly compact = signal(false);
  protected readonly takingOver = computed(() => this.panelOpen() && (this.wideReview() || this.compact()));
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private returnFocus?: HTMLElement;
  private wasOpen?: boolean;
  private wasWide?: boolean;

  constructor() {
    const media = matchMedia('(max-width: 700px)');
    const changed = () => this.compact.set(media.matches);
    changed(); media.addEventListener('change', changed);
    inject(DestroyRef).onDestroy(() => media.removeEventListener('change', changed));
    afterRenderEffect(onCleanup => {
      const open = this.panelOpen();
      const panel = this.root.querySelector<HTMLElement>('.panel');
      const inner = this.root.querySelector<HTMLElement>('.panel-inner');
      if (!panel || !inner) return;
      if (open) {
        inner.style.removeProperty('width');
        this.retainedPanel.set(true);
        this.retainedWide.set(this.wideReview());
        return;
      }
      if (!untracked(this.retainedPanel)) return;
      // Preserve the outgoing layout, including a wide or interrupted panel.
      // Width clipping slides it away without squeezing its contents.
      inner.style.width = `${inner.clientWidth}px`;
      let stopped = false;
      const finish = () => {
        if (stopped || this.panelOpen()) return;
        inner.style.removeProperty('width');
        this.retainedPanel.set(false);
      };
      const frame = requestAnimationFrame(() => {
        const motion = (panel.getAnimations?.() ?? []).filter(animation => 'transitionProperty' in animation && animation.transitionProperty === 'width');
        void Promise.allSettled(motion.map(animation => animation.finished)).then(finish);
      });
      onCleanup(() => { stopped = true; cancelAnimationFrame(frame); inner.style.removeProperty('width'); });
    });
    afterRenderEffect(() => {
      const open = this.panelOpen();
      const wide = this.takingOver();
      const panel = this.root.querySelector<HTMLElement>(".panel");
      const active = document.activeElement;
      // A restored wide panel can already be open on its first render.
      if (wide && this.wasWide !== true)
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
    else if (this.compact() && this.panelOpen()) this.panelCloseRequested.emit();
  }
}
