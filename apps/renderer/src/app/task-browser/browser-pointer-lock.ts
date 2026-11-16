import { signal } from '@angular/core';
import type { TaskBrowserStreamEvent } from '@elevenex/shared';

/** Owns the viewing device's pointer lock; remote page state never grants it silently. */
export class BrowserPointerLock {
  readonly locked = signal(false);
  readonly error = signal('');
  private element?: HTMLCanvasElement;
  private lockEpoch?: number;
  get epoch(): number | undefined { return this.lockEpoch; }
  private revision = 0;
  private readonly changed = () => {
    const locked = !!this.element && document.pointerLockElement === this.element;
    if (!locked && this.locked()) this.unlockHost();
    this.locked.set(locked);
  };
  constructor(private readonly send: (input: TaskBrowserStreamEvent) => void) {
    document.addEventListener('pointerlockchange', this.changed);
  }
  async start(canvas: HTMLCanvasElement, epoch?: number): Promise<void> {
    this.error.set(''); this.element = canvas; this.lockEpoch = epoch;
    const revision = ++this.revision;
    try {
      await canvas.requestPointerLock();
      if (revision !== this.revision) {
        if (this.element !== canvas && document.pointerLockElement === canvas) document.exitPointerLock();
        return;
      }
      this.changed();
    } catch { if (revision === this.revision) this.error.set('Pointer lock was declined. Click Use pointer lock to try again.'); }
  }
  release(notifyHost = true): void {
    this.revision++;
    this.error.set('');
    if (this.element && document.pointerLockElement === this.element) document.exitPointerLock();
    if (this.locked() && notifyHost) this.unlockHost();
    this.locked.set(false); this.element = undefined; this.lockEpoch = undefined;
  }
  private unlockHost(): void {
    this.send({ kind: 'pointer-unlock', ...(this.lockEpoch === undefined ? {} : { pointerLockEpoch: this.lockEpoch }) });
  }
  destroy(): void { this.release(); document.removeEventListener('pointerlockchange', this.changed); }
}
