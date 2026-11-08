import { signal } from '@angular/core';
import type { TaskBrowserStreamEvent } from '@elevenex/shared';

/** Owns the viewing device's pointer lock; remote page state never grants it silently. */
export class BrowserPointerLock {
  readonly locked = signal(false);
  readonly error = signal('');
  private element?: HTMLCanvasElement;
  private revision = 0;
  private readonly changed = () => {
    const locked = !!this.element && document.pointerLockElement === this.element;
    if (!locked && this.locked()) this.send({ kind: 'pointer-unlock' });
    this.locked.set(locked);
  };
  constructor(private readonly send: (input: TaskBrowserStreamEvent) => void) {
    document.addEventListener('pointerlockchange', this.changed);
  }
  async start(canvas: HTMLCanvasElement): Promise<void> {
    this.error.set(''); this.element = canvas;
    const revision = ++this.revision;
    try {
      await canvas.requestPointerLock();
      if (revision !== this.revision) { if (document.pointerLockElement === canvas) document.exitPointerLock(); return; }
      this.changed();
    } catch { if (revision === this.revision) this.error.set('Pointer lock was declined. Click Use pointer lock to try again.'); }
  }
  release(): void {
    this.revision++;
    if (this.element && document.pointerLockElement === this.element) document.exitPointerLock();
    if (this.locked()) this.send({ kind: 'pointer-unlock' });
    this.locked.set(false); this.element = undefined;
  }
  destroy(): void { this.release(); document.removeEventListener('pointerlockchange', this.changed); }
}
