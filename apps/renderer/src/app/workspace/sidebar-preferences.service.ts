import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

const storageKey = 'elevenex.sidebar.session-cap';
const choices = new Set([0, 5, 10, 20]);
function parse(value: string | null): number {
  const cap = value !== null && /^(0|5|10|20)$/.test(value) ? Number(value) : 5;
  return choices.has(cap) ? cap : 5;
}

/** Device-local user preference shared by project views and windows. */
@Injectable({ providedIn: 'root' })
export class SidebarPreferencesService {
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly value = signal(this.read());
  readonly sessionCap = this.value.asReadonly();
  readonly error = signal<string | null>(null);
  readonly options = [{ id: '5', label: '5 sessions' }, { id: '10', label: '10 sessions' }, { id: '20', label: '20 sessions' }, { id: '0', label: 'Show all' }];

  constructor() {
    const update = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) this.value.set(this.read());
    };
    this.window?.addEventListener('storage', update);
    inject(DestroyRef).onDestroy(() => this.window?.removeEventListener('storage', update));
  }
  setSessionCap(value: string): void {
    const cap = Number(value);
    if (!choices.has(cap)) return;
    try {
      if (!this.window) throw new Error('Storage unavailable.');
      this.window.localStorage.setItem(storageKey, String(cap));
      this.value.set(cap); this.error.set(null);
    } catch { this.error.set('The sidebar preference could not be saved on this device.'); }
  }
  private read(): number {
    try { return parse(this.window?.localStorage.getItem(storageKey) ?? null); }
    catch { return 5; }
  }
}
