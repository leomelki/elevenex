import { computed, Injectable, signal, type Signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ModalOverlayStateService {
  private readonly openModalCount = signal(0);

  readonly hasOpenModal: Signal<boolean> = computed(() => this.openModalCount() > 0);

  openModal(_id?: string): () => void {
    let released = false;
    this.openModalCount.update(count => count + 1);

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.openModalCount.update(count => Math.max(0, count - 1));
    };
  }
}
