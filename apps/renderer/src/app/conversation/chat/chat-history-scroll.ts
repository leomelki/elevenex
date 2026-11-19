interface ScrollGeometry {
  readonly top: number;
  readonly height: number;
}

// Limit how far either edge of the native thumb can move in a single paint.
const THUMB_PIXELS_PER_FRAME = 12;

/** Reconcile a page swap's scroll range around the same visible transcript. */
export class ChatHistoryScroll {
  private frame: number | undefined;
  private offset = 0;

  constructor(
    private readonly viewport: HTMLDivElement,
    private readonly track: HTMLDivElement,
    private readonly content: HTMLDivElement,
  ) {}

  get top(): number {
    return this.viewport.scrollTop - this.offset;
  }

  get height(): number {
    return this.frame === undefined ? this.viewport.scrollHeight
      : Math.max(this.viewport.clientHeight, this.content.offsetHeight);
  }

  restore(previous: ScrollGeometry, position: number): void {
    const height = this.height;
    const viewportHeight = this.viewport.clientHeight;
    const top = Math.max(0, Math.min(position, height - viewportHeight));
    this.cancel();
    const travel = (from: number, to: number) =>
      Math.abs(from / previous.height - to / height) * viewportHeight;
    const distance = Math.max(travel(previous.top, top),
      travel(previous.top + viewportHeight, top + viewportHeight));
    if (!Number.isFinite(distance) || distance <= THUMB_PIXELS_PER_FRAME) {
      this.apply(top, 0, 0, height);
      return;
    }

    // Give the first paint the old range and the new transcript. The signed
    // insets represent offscreen content added/removed at either end.
    const leading = Math.round(previous.top - top);
    const trailing = previous.height - height - leading;
    const frames = Math.ceil(distance / THUMB_PIXELS_PER_FRAME);
    let index = 0;
    this.apply(top, leading, trailing, height);
    const advance = () => {
      const nextTop = this.top;
      const nextHeight = this.height;
      const progress = ++index / frames;
      // Interpolate thumb fractions linearly even when the extent changes by
      // several viewport heights. Moving the origin and scroll offset together
      // keeps the transcript still and uses the reader's latest scroll offset.
      const remaining = (1 - progress) * height /
        ((1 - progress) * height + progress * previous.height);
      this.apply(nextTop, Math.round(leading * remaining), Math.round(trailing * remaining), nextHeight);
      this.frame = index < frames ? requestAnimationFrame(advance) : undefined;
    };
    this.frame = requestAnimationFrame(advance);
  }

  finish(): void {
    if (this.frame === undefined) return;
    const top = this.top;
    const height = this.height;
    this.cancel();
    this.apply(top, 0, 0, height);
  }

  cancel(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  private apply(top: number, leading: number, trailing: number, height: number): void {
    const viewportHeight = this.viewport.clientHeight;
    const currentTop = this.viewport.scrollTop;
    this.offset = leading;
    const active = leading !== 0 || trailing !== 0;
    this.viewport.classList.toggle('reconciling-history', active);
    this.track.style.blockSize = active ? `${Math.max(viewportHeight, height + leading + trailing)}px` : '';
    this.content.style.translate = leading ? `0 ${leading}px` : '';
    const target = Math.max(0, Math.min(top, height - viewportHeight)) + leading;
    if (Math.abs(currentTop - target) >= 0.5) this.viewport.scrollTop = target;
  }
}
