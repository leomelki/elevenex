import { copyModalFace, measureModalOrigin, ModalBox, modalMorphFrames, MODAL_LAUNCH_EASING } from './modal-morph';

/** Owns modal animation handles and decorative copies. The component owns focus and presence. */
export class ModalMotion {
  private animations: Animation[] = [];
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private readonly reducedChanged = () => { if (this.media?.matches) this.animations.forEach(animation => animation.finish()); };
  private readonly surface: HTMLElement | null;
  private readonly dim: HTMLElement;
  private window: Element | null;
  private origin?: ModalBox;
  private face?: HTMLElement;
  private shadow?: HTMLElement;
  private range: readonly [number, number] = [0, 1];
  private generation = 0;
  private restoreOrigin?: () => void;
  private restoreTrigger?: () => void;
  private returnElement: HTMLElement | null;

  get returnTarget(): HTMLElement | null { return this.returnElement; }

  constructor(private readonly layer: HTMLElement, private from: HTMLElement | null = null, private readonly options: { readonly noFace?: boolean; readonly fadeIn?: number } = {}) {
    this.returnElement = from;
    this.media?.addEventListener('change', this.reducedChanged);
    this.surface = layer.firstElementChild instanceof HTMLElement ? layer.firstElementChild : null;
    // Imperative popovers use the same motion owner without a modal backdrop.
    this.dim = layer.querySelector<HTMLElement>(':scope > .ex-modal-dim') ?? layer;
    this.window = from?.closest('[data-modal-window], .ex-window, ex-app-shell') ?? null;
    if (!this.media?.matches && from?.isConnected && this.surface?.animate) {
      const origin = measureModalOrigin(layer, from);
      if (origin.width > 0 && origin.height > 0) {
        this.origin = origin;
        if (!this.options.noFace) this.face = copyModalFace(from);
        layer.classList.add('ex-modal-has-from');
        const original = this.surface.style.transformOrigin;
        this.restoreOrigin = () => { if (this.surface) this.surface.style.transformOrigin = original; };
        this.surface.style.transformOrigin = '50% 50%';
        void this.retarget(true);
      }
    }
    if (this.options.noFace && !this.origin) void this.retarget(true);
  }

  async retarget(open: boolean, from: HTMLElement | null = this.from): Promise<boolean> {
    const surface = this.surface;
    if (!surface) return true;
    const timing = this.animations[0]?.effect?.getComputedTiming().progress;
    const value = timing == null ? open ? 0 : 1 : this.range[0] + (this.range[1] - this.range[0]) * timing;
    // Snapshot painted values before cancelling: rapid reversals start at exactly this frame.
    const layerStyle = getComputedStyle(this.layer), surfaceStyle = getComputedStyle(surface);
    const painted = { opacity: surfaceStyle.opacity, transform: surfaceStyle.transform, clipPath: surfaceStyle.clipPath };
    const dimOpacity = getComputedStyle(this.dim).opacity;
    const content = Array.from(surface.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const contentOpacity = content.map(child => getComputedStyle(child).opacity);
    const copyPose = (element?: HTMLElement) => {
      if (!element?.isConnected) return undefined;
      const style = getComputedStyle(element);
      return { transform: style.transform, opacity: style.opacity };
    };
    const facePose = copyPose(this.face), shadowPose = copyPose(this.shadow);
    this.cancelAnimations();
    const generation = this.generation;
    if (this.media?.matches || !this.layer.animate || !surface.animate) {
      this.layer.classList.remove('ex-modal-has-from');
      this.removeCopies();
      if (this.options.noFace && surface.animate) {
        const animation = surface.animate([{ opacity: open ? '0' : painted.opacity }, { opacity: open ? '1' : '0' }], { duration: 140, fill: 'both' });
        this.animations = [animation];
        try { await animation.finished; } catch { return false; }
        if (generation !== this.generation) return false;
        if (open) this.cancelAnimations();
      }
      return true;
    }
    this.layer.classList.add('ex-modal-layer-retargeting');
    if (open && !this.origin && from?.isConnected) {
      // A new draft can reopen before a successful creation's plain exit ends.
      this.from = from;
      this.returnElement = from;
      this.window = from.closest('[data-modal-window], .ex-window, ex-app-shell');
      this.origin = measureModalOrigin(this.layer, from);
      if (!this.options.noFace) this.face = copyModalFace(from);
      this.layer.classList.add('ex-modal-has-from');
    }
    if (!open && !from) {
      // Successful creation leaves plainly instead of returning to its + tile.
      this.origin = undefined;
      this.restoreTrigger?.(); this.restoreTrigger = undefined;
      this.removeCopies();
      this.layer.classList.remove('ex-modal-has-from');
    }
    if (this.origin) {
      // Resolve a replacement only at rest. During a reversal the original geometry must survive.
      if (!open && timing == null) this.resolveReturnTarget();
      const dialog: ModalBox = { left: surface.offsetLeft, top: surface.offsetTop, width: surface.offsetWidth, height: surface.offsetHeight, radius: parseFloat(surfaceStyle.borderTopLeftRadius) || 0 };
      if (!dialog.width || !dialog.height) return true;
      const frames = modalMorphFrames(this.origin, dialog, value, open ? 1 : 0, this.options.fadeIn);
      if (timing != null) {
        frames.surface[0] = { offset: 0, ...painted };
        if (facePose) frames.face[0] = { offset: 0, ...facePose };
        if (shadowPose) frames.shadow[0] = { offset: 0, ...shadowPose };
      }
      this.range = [value, open ? 1 : 0];
      const options: KeyframeAnimationOptions = { duration: open ? 560 : 500, easing: MODAL_LAUNCH_EASING, fill: 'both' };
      this.shadow ??= this.layer.ownerDocument.createElement('div');
      this.shadow.className = 'ex-modal-shadow';
      this.shadow.setAttribute('aria-hidden', 'true');
      Object.assign(this.shadow.style, { position: 'absolute', margin: '0', transformOrigin: '0 0', pointerEvents: 'none', left: `${dialog.left}px`, top: `${dialog.top}px`, width: `${dialog.width}px`, height: `${dialog.height}px`, borderRadius: `${dialog.radius}px`, boxShadow: surfaceStyle.boxShadow });
      this.layer.append(this.shadow);
      this.animations = [surface.animate(frames.surface, options), this.shadow.animate(frames.shadow, options)];
      content.forEach((child, index) => this.animations.push(child.animate(timing == null ? frames.content : [{ offset: 0, opacity: contentOpacity[index] }, ...frames.content.slice(1)], options)));
      if (this.face) {
        Object.assign(this.face.style, { left: `${this.origin.left}px`, top: `${this.origin.top}px`, width: `${this.origin.width}px`, height: `${this.origin.height}px` });
        this.layer.append(this.face);
        // The dialog owns the card's pixels until it closes. Keep the real
        // trigger in layout without making it reappear behind the open dialog.
        if (!this.restoreTrigger && this.returnElement) {
          const trigger = this.returnElement, visibility = trigger.style.visibility;
          this.restoreTrigger = () => { trigger.style.visibility = visibility; };
          trigger.style.visibility = 'hidden';
        }
        this.animations.push(this.face.animate(frames.face, options));
      }
      if (!this.options.noFace) this.animations.push(this.dim.animate([{ opacity: timing == null && open ? '0' : dimOpacity }, { opacity: open ? '1' : '0' }], options));
    } else {
      const duration = parseFloat(layerStyle.getPropertyValue(open ? '--dur-slow' : '--dur-base')) || (open ? 280 : 200);
      const easing = layerStyle.getPropertyValue(open ? '--ease-out' : '--ease-in').trim();
      this.animations = [
        surface.animate([painted, { opacity: open ? '1' : '0', transform: open ? 'none' : 'translateY(-8px) scale(.985)' }], { duration, easing, fill: 'both' }),
        this.dim.animate([{ opacity: dimOpacity }, { opacity: open ? '1' : '0' }], { duration, easing, fill: 'both' }),
      ];
    }
    try { await Promise.all(this.animations.map(animation => animation.finished)); }
    catch { return false; }
    if (generation !== this.generation) return false;
    // Closing retains its final (invisible) frame until the owner removes the portal.
    if (open) { this.cancelAnimations(); this.removeCopies(); }
    return true;
  }

  dispose(): void {
    this.cancelAnimations(); this.removeCopies(); this.restoreOrigin?.();
    this.restoreTrigger?.(); this.restoreTrigger = undefined;
    this.media?.removeEventListener('change', this.reducedChanged);
  }

  private resolveReturnTarget(): void {
    if (!this.origin) return;
    if (this.options.noFace && this.from?.isConnected) {
      this.returnElement = this.from;
      this.origin = measureModalOrigin(this.layer, this.from, 'resting');
      return;
    }
    // Hidden cards cannot be hit-tested. Restore only within this synchronous
    // retarget, before the selected return card is hidden again for the exit.
    this.restoreTrigger?.(); this.restoreTrigger = undefined;
    const outer = this.layer.getBoundingClientRect();
    const scale = (this.layer.offsetWidth ? outer.width / this.layer.offsetWidth : 1) || 1;
    const x = outer.left + (this.origin.left + this.origin.width / 2) * scale;
    const y = outer.top + (this.origin.top + this.origin.height / 2) * scale;
    const hit = this.layer.ownerDocument.elementsFromPoint?.(x, y).find(element => !this.layer.contains(element) && !!this.window?.contains(element));
    const target = hit?.closest<HTMLElement>('[data-machine], [data-grid-key], button') ?? (this.from?.isConnected ? this.from : undefined);
    if (!target || target.offsetWidth <= 0 || target.offsetHeight <= 0) return;
    this.returnElement = target;
    this.origin = measureModalOrigin(this.layer, target, 'resting');
    if (!this.options.noFace) this.face = copyModalFace(target);
  }

  private cancelAnimations(): void {
    this.generation++;
    for (const animation of this.animations.splice(0)) animation.cancel();
  }
  private removeCopies(): void {
    this.face?.remove(); this.shadow?.remove();
  }
}
