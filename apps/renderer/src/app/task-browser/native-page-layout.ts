import type { TaskBrowserLayout } from '@elevenex/shared';

/** Native surfaces sit above DOM. Detach during motion/overlays rather than covering app controls.
 * A bounded heartbeat also makes main fail closed if this document freezes or goes away. */
export class NativePageLayout {
  private frame = 0;
  private sequence = 0;
  private previous = '';
  private lastSent = 0;
  private stopped = false;
  private pending = false;
  private overlayBlocked = false;
  private readonly observer: MutationObserver;
  private readonly invalidate = () => { this.previous = ''; };
  private readonly keyInput = (event: KeyboardEvent) => {
    this.invalidate();
    if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable]')) void this.hide().catch(() => undefined);
  };
  constructor(private readonly surface: () => HTMLElement | undefined,
    private readonly visible: () => boolean, private readonly send: (layout: Omit<TaskBrowserLayout, 'surfaceEpoch' | 'ownerGeneration'>) => Promise<void>,
    private readonly hide: () => Promise<void>, private readonly epoch: () => number = () => 0, private readonly overlays: HTMLElement = document.body, private readonly ownerGeneration: () => number = () => 0) {
    document.addEventListener('pointerdown', this.invalidate, true);
    document.addEventListener('keydown', this.keyInput, true);
    this.observer = new MutationObserver(() => this.checkOverlays(this.surface()?.getBoundingClientRect()));
    this.observer.observe(overlays, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'role'] });
    this.frame = requestAnimationFrame(() => this.measure());
  }
  private measure(): void {
    if (this.stopped) return;
    const surface = this.surface(), rect = surface?.getBoundingClientRect();
    const blocked = !surface || !this.visible() || document.hidden || !!surface.closest('[inert], [hidden]') ||
      this.checkOverlays(rect);
    let moving = false;
    if (!blocked) {
      // Only animations affecting this page's geometry; unrelated streaming text stays cheap.
      for (let node: HTMLElement | null = surface; node; node = node.parentElement) {
        if (node.getAnimations().some(animation => animation.playState === 'running' && !(animation.effect?.getTiming().iterations === Infinity))) { moving = true; break; }
      }
    }
    const visible = !blocked && !moving && !!rect && rect.width >= 2 && rect.height >= 2;
    const box = rect ? { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(0, Math.min(rect.right, innerWidth) - Math.max(0, rect.x)), height: Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y)) } : { x: 0, y: 0, width: 0, height: 0 };
    const folds = surface?.closest('ex-task-browser')?.querySelectorAll('ex-fold') ?? [];
    const inputReady = visible && !Array.from(folds).some(fold => fold.getAnimations().some(animation => animation.playState === 'running'));
    const identity = JSON.stringify([visible, inputReady, box, this.epoch(), this.ownerGeneration()]);
    if (!this.pending && (identity !== this.previous || performance.now() - this.lastSent > 250)) {
      this.previous = identity; this.lastSent = performance.now(); this.pending = true;
      void this.send({ sequence: this.sequence = Math.max(this.sequence + 1, Math.floor(performance.now() * 1000)), visible, inputReady, bounds: box, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }).catch(() => undefined).finally(() => { this.pending = false; });
    }
    this.frame = requestAnimationFrame(() => this.measure());
  }
  private checkOverlays(rect?: DOMRect): boolean {
    let blocked = !!this.overlays.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]');
    if (!blocked && rect) for (const pane of Array.from(this.overlays.querySelectorAll('.cdk-overlay-pane')).slice(0, 32)) {
      const box = pane.getBoundingClientRect();
      if (box.width && box.height && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top) { blocked = true; break; }
    }
    if (blocked && !this.overlayBlocked) { this.invalidate(); void this.hide().catch(() => undefined); }
    if (blocked !== this.overlayBlocked) this.invalidate();
    this.overlayBlocked = blocked; return blocked;
  }
  destroy(): void { document.removeEventListener('pointerdown', this.invalidate, true); document.removeEventListener('keydown', this.keyInput, true); this.observer.disconnect(); this.stopped = true; cancelAnimationFrame(this.frame); void this.hide().catch(() => undefined); }
}
