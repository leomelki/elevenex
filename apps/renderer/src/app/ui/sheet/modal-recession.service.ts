import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

export interface ModalRecessionLease {
  readonly release: () => void;
  readonly isTop: () => boolean;
}

/** A modal owns one lease. Nested confirmations share the same background lease count. */
@Injectable({ providedIn: 'root' })
export class ModalRecessionService {
  private readonly document = inject(DOCUMENT);
  private readonly backgrounds = new Map<HTMLElement, { count: number; inert: boolean }>();
  private readonly layers: { token: object; overlay?: HTMLElement }[] = [];

  acquire(origin: HTMLElement, overlay?: HTMLElement): ModalRecessionLease {
    const window = origin.closest<HTMLElement>('[data-modal-window], .ex-window, ex-app-shell');
    const background = window
      ? window.querySelector<HTMLElement>(':scope > .ex-shell, :scope > .regions, ex-app-shell > .regions, [data-modal-background]')
      : this.document.querySelector<HTMLElement>('[data-modal-background], ex-app-shell > .regions');
    const token = {};
    this.layers.at(-1)?.overlay?.setAttribute('inert', '');
    this.layers.push({ token, overlay });
    if (background) {
      const state = this.backgrounds.get(background) ?? { count: 0, inert: background.hasAttribute('inert') };
      state.count++;
      this.backgrounds.set(background, state);
      background.classList.add('ex-recession-surface', 'is-receded');
      background.setAttribute('data-recede', String(state.count));
      background.setAttribute('inert', '');
    }
    let active = true;
    return {
      isTop: () => this.layers.at(-1)?.token === token,
      release: () => {
        if (!active) return;
        active = false;
        const index = this.layers.findIndex(layer => layer.token === token);
        const wasTop = index === this.layers.length - 1;
        if (index >= 0) this.layers.splice(index, 1);
        if (wasTop) this.layers.at(-1)?.overlay?.removeAttribute('inert');
        if (!background) return;
        const state = this.backgrounds.get(background);
        if (!state) return;
        state.count--;
        background.setAttribute('data-recede', String(state.count));
        if (!state.count) {
          background.classList.remove('is-receded');
          if (!state.inert) background.removeAttribute('inert');
          this.backgrounds.delete(background);
        }
      },
    };
  }
}
