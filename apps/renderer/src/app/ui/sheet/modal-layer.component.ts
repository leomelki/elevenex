import { A11yModule, CdkTrapFocus } from '@angular/cdk/a11y';
import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { CdkPortal, PortalModule } from '@angular/cdk/portal';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, ViewEncapsulation, afterRenderEffect, inject, input, output, signal, viewChild } from '@angular/core';
import { ModalRecessionService } from './modal-recession.service';
import { ModalMotion } from './modal-motion';

/** The caller supplies a labelled dialog. The layer owns focus, dismissal and its overlay lifetime. */
@Component({
  selector: 'ex-modal-layer',
  imports: [A11yModule, PortalModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Projected dialogs must animate around their own box, not an extra full-height wrapper.
  encapsulation: ViewEncapsulation.None,
  templateUrl: './modal-layer.component.html',
  styleUrl: './modal-layer.component.css',
})
export class ModalLayerComponent {
  readonly open = input(true);
  readonly align = input<'center' | 'top'>('center');
  readonly from = input<HTMLElement | null>(null);
  readonly closeRequested = output<void>();
  /** Emitted after the retained exit completes, focus is restored and the portal detaches. */
  readonly closed = output<void>();
  protected readonly leaving = signal(false);
  private readonly portal = viewChild(CdkPortal);
  private readonly trap = viewChild(CdkTrapFocus);
  private readonly origin = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly overlay = inject(Overlay);
  private readonly recession = inject(ModalRecessionService);
  private overlayRef?: OverlayRef;
  private returnFocus?: HTMLElement;
  private returnAncestor?: HTMLElement;
  private motion?: ModalMotion;
  private mode?: 'open' | 'closing';
  private lease?: ReturnType<ModalRecessionService['acquire']>;

  constructor() {
    afterRenderEffect(() => {
      const portal = this.portal();
      if (this.open() && portal) {
        const reopening = this.overlayRef && this.mode === 'closing';
        if (reopening) void this.motion?.retarget(true, this.from());
        // A newly attached portal must read the entry state on its first template check.
        this.leaving.set(false);
        if (!this.overlayRef) {
          const active = this.origin.ownerDocument.activeElement;
          this.returnFocus = active instanceof HTMLElement && active !== this.origin.ownerDocument.body ? active : undefined;
          // Removal dialogs can delete their own opener. Remember its nearest
          // keyboard region while the opener still belongs to the document.
          this.returnAncestor = (this.from() ?? this.returnFocus)?.parentElement?.closest<HTMLElement>('[tabindex], button, a[href], input, select, textarea') ?? undefined;
          this.overlayRef = this.overlay.create({
            positionStrategy: this.overlay.position().global().top('0').left('0'),
            width: '100%', height: '100%',
            scrollStrategy: this.overlay.scrollStrategies.block(),
          });
          this.overlayRef.attach(portal);
          const layer = this.overlayRef.overlayElement.querySelector<HTMLElement>('.ex-modal-layer');
          if (layer) this.motion = new ModalMotion(layer, this.from());
        }
        this.mode = 'open';
        this.lease ??= this.recession.acquire(this.origin, this.overlayRef.overlayElement);
        if (reopening) {
          const layer = this.overlayRef.overlayElement.querySelector<HTMLElement>('.ex-modal-layer');
          // Inert blurs the outgoing control. CDK's initial auto-capture does
          // not repeat when the same trap is enabled again after a reversal.
          if (layer && !layer.contains(layer.ownerDocument.activeElement)
            && !this.trap()?.focusTrap.focusInitialElement({ preventScroll: true })) layer.focus({ preventScroll: true });
        }
      } else if (this.overlayRef && this.mode !== 'closing') {
        this.mode = 'closing';
        this.lease?.release();
        this.lease = undefined;
        const exit = this.motion?.retarget(false, this.from()) ?? Promise.resolve(true);
        this.leaving.set(true);
        void exit.then(completed => {
          if (completed && this.mode === 'closing' && !this.open()) {
            this.disposeOverlay();
            this.closed.emit();
          }
        });
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.lease?.release();
      this.disposeOverlay();
    });
  }

  protected dismiss(event: Event): void {
    if (!this.open() || !this.lease?.isTop()) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeRequested.emit();
  }

  protected backdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.dismiss(event);
  }

  private disposeOverlay(): void {
    const opener = [this.returnFocus, this.motion?.returnTarget, this.returnAncestor]
      .find(element => element?.isConnected && !element.closest('[inert]') && !element.matches(':disabled')
        && (element.tabIndex >= 0 || element.hasAttribute('tabindex')));
    this.motion?.dispose();
    this.motion = undefined;
    this.mode = undefined;
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
    // CDK can observe a child's early autofocus as its opener. Keep the actual pre-portal opener instead.
    this.returnFocus = undefined;
    this.returnAncestor = undefined;
    if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
  }
}
