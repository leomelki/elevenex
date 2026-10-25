import { A11yModule } from '@angular/cdk/a11y';
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
  protected readonly leaving = signal(false);
  private readonly portal = viewChild(CdkPortal);
  private readonly origin = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly overlay = inject(Overlay);
  private readonly recession = inject(ModalRecessionService);
  private overlayRef?: OverlayRef;
  private returnFocus?: HTMLElement;
  private motion?: ModalMotion;
  private mode?: 'open' | 'closing';
  private lease?: ReturnType<ModalRecessionService['acquire']>;
  private exitTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    afterRenderEffect(() => {
      const portal = this.portal();
      if (this.open() && portal) {
        clearTimeout(this.exitTimer);
        if (this.overlayRef && this.mode === 'closing') this.motion?.retarget(true);
        // A newly attached portal must read the entry state on its first template check.
        this.leaving.set(false);
        if (!this.overlayRef) {
          const active = this.origin.ownerDocument.activeElement;
          this.returnFocus = active instanceof HTMLElement ? active : undefined;
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
      } else if (this.overlayRef && this.mode !== 'closing') {
        this.motion?.retarget(false);
        this.mode = 'closing';
        this.leaving.set(true);
        this.lease?.release();
        this.lease = undefined;
        const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.exitTimer = setTimeout(() => {
          this.disposeOverlay();
        }, reduced ? 0 : 220);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.exitTimer);
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
    this.motion?.dispose();
    this.motion = undefined;
    this.mode = undefined;
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
    // CDK can observe a child's early autofocus as its opener. Keep the actual pre-portal opener instead.
    const opener = this.returnFocus;
    this.returnFocus = undefined;
    if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
  }
}
