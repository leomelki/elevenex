import { Directive, ElementRef, HostListener, OnDestroy, effect, inject, input } from '@angular/core';
import { ModalOverlayStateService } from '@/shared/services/modal-overlay-state.service';

@Directive({
  selector: 'dialog[trackNativeModal]',
  standalone: true,
  exportAs: 'trackedNativeModal',
})
export class TrackNativeModalDirective implements OnDestroy {
  readonly trackNativeModalOpen = input<boolean | undefined>(undefined);

  private readonly dialog = inject(ElementRef<HTMLDialogElement>).nativeElement;
  private readonly modalOverlayState = inject(ModalOverlayStateService);

  private releaseModal: (() => void) | null = null;

  constructor() {
    effect(() => {
      const isOpen = this.trackNativeModalOpen();
      if (isOpen === undefined) {
        return;
      }

      if (isOpen) {
        this.open();
      } else {
        this.close();
      }
    });

    queueMicrotask(() => {
      if (this.dialog.open) {
        this.ensureTracked();
      }
    });
  }

  open(): void {
    this.ensureTracked();

    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  close(returnValue?: string): void {
    if (this.dialog.open) {
      this.dialog.close(returnValue);
      return;
    }

    this.releaseTracking();
  }

  @HostListener('close')
  handleClose(): void {
    this.releaseTracking();
  }

  @HostListener('cancel')
  handleCancel(): void {
    this.releaseTracking();
  }

  ngOnDestroy(): void {
    this.releaseTracking();
  }

  private ensureTracked(): void {
    if (this.releaseModal) {
      return;
    }

    this.releaseModal = this.modalOverlayState.openModal();
  }

  private releaseTracking(): void {
    this.releaseModal?.();
    this.releaseModal = null;
  }
}
