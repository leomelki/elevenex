import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  signal,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  inject,
  input,
  linkedSignal,
  output,
  untracked,
  viewChild,
} from "@angular/core";
import { _IdGenerator } from '@angular/cdk/a11y';
import { TitleBarComponent } from "../machines/title-bar.component";
import { PanelResizeDirective } from './panel-resize.directive';

/** Region layout only. The owning feature supplies navigation, chat and side views. */
@Component({
  selector: "ex-app-shell",
  imports: [TitleBarComponent, PanelResizeDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.embedded]": "!titleBar()",
    "[class.panel-open]": "panelOpen()",
    "[class.panel-retained]": "panelPresent()",
    "[class.wide-review]": "takingOver()",
    "[class.direct-panel-width]": "directWidth()",
    "[class.panel-resizing]": "panelResizing()",
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
  protected readonly panelId = inject(_IdGenerator).getId('ex-side-panel-');
  private readonly workspace = viewChild.required<ElementRef<HTMLElement>>('workspace');
  private readonly availableWidth = signal(0);
  private readonly defaultWidth = signal(440);
  private readonly preferredWidth = signal<number | null>(null);
  private widthBeforeDrag: number | null = null;
  protected readonly panelMinimum = computed(() => Math.min(320, Math.floor(this.availableWidth() / 2)));
  protected readonly panelMaximum = computed(() => {
    const available = this.availableWidth();
    // Reserve room for writing. In smaller split layouts, keep a proportional
    // chat column so both panes still have room to adjust before compact mode.
    const chat = Math.min(360, Math.ceil(available * 0.4));
    return Math.min(1000, available - chat);
  });
  protected readonly panelWidth = computed(() => this.availableWidth() > 0
    ? Math.max(this.panelMinimum(), Math.min(this.panelMaximum(), this.preferredWidth() ?? this.defaultWidth()))
    : null);
  protected readonly canResize = computed(() =>
    this.panelOpen() && !this.takingOver() && this.panelMaximum() > this.panelMinimum());
  readonly panelResizing = linkedSignal({ source: this.canResize, computation: () => false });
  // Direct interaction and fit changes have no easing. Visibility and takeover
  // changes reset this flag so the shell still owns their width transitions.
  protected readonly directWidth = linkedSignal({ source: this.canResize, computation: () => false });
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private returnFocus?: HTMLElement;
  private wasOpen?: boolean;
  private wasWide?: boolean;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const media = matchMedia('(max-width: 700px)');
    const changed = () => this.compact.set(media.matches);
    changed(); media.addEventListener('change', changed);
    destroyRef.onDestroy(() => media.removeEventListener('change', changed));
    afterNextRender(() => {
      const workspace = this.workspace().nativeElement;
      const styles = getComputedStyle(workspace);
      const gutter = Number.parseFloat(styles.getPropertyValue('--space-2')) || 8;
      const defaultWidth = Number.parseFloat(styles.getPropertyValue('--panel-width'));
      if (defaultWidth > 0) this.defaultWidth.set(defaultWidth);
      const measure = () => {
        const previous = this.panelWidth();
        this.availableWidth.set(Math.max(0, workspace.clientWidth - gutter));
        if (previous !== null && previous !== this.panelWidth() && this.canResize()) this.directWidth.set(true);
      };
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(workspace);
      destroyRef.onDestroy(() => observer.disconnect());
    });
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
      const peek = this.root.querySelector<HTMLElement>(".peek");
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
          (active instanceof Node && (panel?.contains(active) || peek?.contains(active))))
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

  protected resizePanel(width: number | null): void {
    if (width !== null) {
      width = Math.max(this.panelMinimum(), Math.min(this.panelMaximum(), width));
      if (width === this.panelWidth()) return;
    }
    this.directWidth.set(true);
    this.preferredWidth.set(width);
  }

  protected startResize(): void {
    this.widthBeforeDrag = this.preferredWidth();
    this.panelResizing.set(true);
  }

  protected endResize(cancelled: boolean): void {
    if (cancelled) this.preferredWidth.set(this.widthBeforeDrag);
    this.panelResizing.set(false);
  }

  protected rememberFocus(event: FocusEvent): void {
    // The chat peek belongs to the takeover; leaving it restores focus to the chat.
    if (event.target instanceof HTMLElement && !event.target.closest(".panel, .peek"))
      this.returnFocus = event.target;
  }
  protected leaveReview(): void {
    if (this.wideReview()) this.reviewExited.emit();
    else if (this.compact() && this.panelOpen()) this.panelCloseRequested.emit();
  }
}
