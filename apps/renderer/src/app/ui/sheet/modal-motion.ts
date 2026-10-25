/** Owns only the layer and its direct surface's interrupted transitions. First entry remains reference CSS. */
export class ModalMotion {
  private readonly animations: Animation[] = [];
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private readonly reducedChanged = () => { if (this.media?.matches) this.cancel(); };
  private restoreOrigin?: () => void;

  constructor(private readonly layer: HTMLElement, from: HTMLElement | null = null) {
    this.media?.addEventListener('change', this.reducedChanged);
    const surface = layer.firstElementChild;
    if (from?.isConnected && surface instanceof HTMLElement) {
      // Measure the resting surface without its entry transform. Normalize any
      // outer scale so dialogs also grow correctly in a zoomed preview/window.
      surface.classList.add('ex-modal-measuring');
      const trigger = from.getBoundingClientRect();
      const box = surface.getBoundingClientRect();
      const scale = layer.offsetWidth ? layer.getBoundingClientRect().width / layer.offsetWidth : 1;
      const originalOrigin = surface.style.transformOrigin;
      this.restoreOrigin = () => { surface.style.transformOrigin = originalOrigin; };
      surface.style.transformOrigin = `${(trigger.left + trigger.width / 2 - box.left) / (scale || 1)}px ${(trigger.top + trigger.height / 2 - box.top) / (scale || 1)}px`;
      surface.classList.remove('ex-modal-measuring');
      layer.classList.add('ex-modal-has-from');
    }
  }

  retarget(open: boolean): void {
    const surface = this.layer.firstElementChild;
    if (!(surface instanceof HTMLElement)) return;
    // Read both painted frames before disabling CSS or cancelling the previous owned animations.
    const layerStyle = getComputedStyle(this.layer);
    const surfaceStyle = getComputedStyle(surface);
    const fromLayer = { opacity: layerStyle.opacity };
    const fromSurface = { opacity: surfaceStyle.opacity, transform: surfaceStyle.transform };
    const anchored = this.layer.classList.contains('ex-modal-has-from');
    this.layer.classList.add('ex-modal-layer-retargeting');
    this.cancel();
    if (this.media?.matches || !this.layer.animate || !surface.animate) return;
    const exit = parseFloat(layerStyle.getPropertyValue('--dur-base')) || 200;
    const fade = parseFloat(layerStyle.getPropertyValue('--dur-glide')) || 340;
    const easing = open
      ? layerStyle.getPropertyValue('--ease-out').trim() || 'cubic-bezier(.16,1,.3,1)'
      : layerStyle.getPropertyValue('--ease-in').trim() || 'cubic-bezier(.4,0,1,1)';
    this.animations.push(
      this.layer.animate([fromLayer, { opacity: open ? '1' : '0' }], { duration: open ? fade : exit, easing, fill: 'both' }),
      surface.animate([fromSurface, { opacity: open ? '1' : '0', transform: open ? 'none' : anchored ? 'scale(.42)' : 'translateY(-8px) scale(.985)' }], {
        duration: open ? anchored ? 460 : 560 : exit,
        easing: open ? 'cubic-bezier(.32,.72,0,1)' : easing,
        fill: 'both',
      }),
    );
  }

  dispose(): void { this.cancel(); this.restoreOrigin?.(); this.media?.removeEventListener('change', this.reducedChanged); }
  private cancel(): void { for (const animation of this.animations.splice(0)) animation.cancel(); }
}
