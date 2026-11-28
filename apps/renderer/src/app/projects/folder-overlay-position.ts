import { FlexibleConnectedPositionStrategy, type ConnectedPosition, type OverlayRef } from '@angular/cdk/overlay';

/** CDK handles scrolling/viewport changes, but ancestor transforms emit neither.
 * One attached folder popup owns this observer, bounded frame loop and finite
 * animation listeners. Its creator must dispose it on detach/destruction. */
export class FolderOverlayPosition {
  private positionFrame?: number;
  private originResize?: ResizeObserver;
  private removeAnimationListeners?: () => void;
  private disposed = false;

  constructor(
    private readonly origin: HTMLElement,
    private readonly overlay: OverlayRef,
    private readonly positions: readonly ConnectedPosition[],
  ) {
    if (typeof ResizeObserver !== 'undefined') {
      this.originResize = new ResizeObserver(() => this.followPosition());
      this.originResize.observe(origin);
    }
    this.followPosition();
  }

  dispose(): void {
    this.disposed = true;
    this.stopPositionFrames();
    this.originResize?.disconnect();
    this.originResize = undefined;
  }

  private followPosition(): void {
    this.stopPositionFrames();
    const origin = this.origin;
    const overlay = this.overlay;
    if (this.disposed || !overlay.hasAttached()) return;
    const ancestors: HTMLElement[] = [];
    for (let element: HTMLElement | null = origin; element && ancestors.length < 32; element = element.parentElement) ancestors.push(element);
    const animations = new Set<Animation>();
    const refreshAfterAnimation = () => this.followPosition();
    this.removeAnimationListeners = () => {
      for (const animation of animations) {
        animation.removeEventListener('finish', refreshAfterAnimation);
        animation.removeEventListener('cancel', refreshAfterAnimation);
      }
    };
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const started = performance.now();
    let frames = 0;
    let stable = 0;
    let previous = origin.getBoundingClientRect();
    const refresh = () => {
      this.positionFrame = undefined;
      if (this.disposed || !overlay.hasAttached() || !origin.isConnected) { this.dispose(); return; }
      // The first render may start an animation one frame after attachment.
      for (const ancestor of ancestors) for (const animation of ancestor.getAnimations?.() ?? []) {
        if (animation.playState !== 'running' && animation.playState !== 'paused') continue;
        const end = animation.effect?.getComputedTiming().endTime;
        if (!Number.isFinite(Number(end)) || animations.has(animation)) continue;
        animations.add(animation);
        animation.addEventListener('finish', refreshAfterAnimation);
        animation.addEventListener('cancel', refreshAfterAnimation);
      }
      const rect = origin.getBoundingClientRect();
      const scaleX = origin.offsetWidth ? rect.width / origin.offsetWidth : 1;
      const scaleY = origin.offsetHeight ? rect.height / origin.offsetHeight : 1;
      const strategy = overlay.getConfig().positionStrategy;
      if (strategy instanceof FlexibleConnectedPositionStrategy) strategy.withPositions(this.positions.map(position => ({ ...position, offsetX: -scaleX, offsetY: 6 * scaleY })));
      overlay.updateSize({ width: rect.width + 2 * scaleX });
      overlay.updatePosition();
      stable = Math.abs(previous.x - rect.x) < .1 && Math.abs(previous.y - rect.y) < .1 && Math.abs(previous.width - rect.width) < .1 && Math.abs(previous.height - rect.height) < .1 ? stable + 1 : 0;
      previous = rect;
      const moving = [...animations].some(animation => animation.playState === 'running' || animation.playState === 'paused');
      frames++;
      if (frames < (reduced ? 2 : 120) && performance.now() - started < 2000 && (frames < 2 || moving || (animations.size > 0 && stable < 2))) this.positionFrame = requestAnimationFrame(refresh);
      // A paused capture may outlive this budget. Its finite animation's finish
      // event still schedules a final pair of frames, without polling forever.
    };
    this.positionFrame = requestAnimationFrame(refresh);
  }

  private stopPositionFrames(): void {
    if (this.positionFrame !== undefined) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = undefined;
    this.removeAnimationListeners?.();
    this.removeAnimationListeners = undefined;
  }
}
