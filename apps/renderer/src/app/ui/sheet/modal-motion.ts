/** Owns only the layer and its direct surface's interrupted transitions. First entry remains reference CSS. */
export class ModalMotion {
  private readonly animations: Animation[] = [];
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private readonly reducedChanged = () => { if (this.media?.matches) this.cancel(); };

  constructor(private readonly layer: HTMLElement) {
    this.media?.addEventListener('change', this.reducedChanged);
  }

  retarget(open: boolean): void {
    const surface = this.layer.firstElementChild;
    if (!(surface instanceof HTMLElement)) return;
    // Read both painted frames before disabling CSS or cancelling the previous owned animations.
    const layerStyle = getComputedStyle(this.layer);
    const surfaceStyle = getComputedStyle(surface);
    const fromLayer = { opacity: layerStyle.opacity };
    const fromSurface = { opacity: surfaceStyle.opacity, transform: surfaceStyle.transform };
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
      surface.animate([fromSurface, { opacity: open ? '1' : '0', transform: open ? 'none' : 'translateY(-8px) scale(.985)' }], {
        duration: open ? 560 : exit,
        easing: open ? 'cubic-bezier(.32,.72,0,1)' : easing,
        fill: 'both',
      }),
    );
  }

  dispose(): void { this.cancel(); this.media?.removeEventListener('change', this.reducedChanged); }
  private cancel(): void { for (const animation of this.animations.splice(0)) animation.cancel(); }
}
