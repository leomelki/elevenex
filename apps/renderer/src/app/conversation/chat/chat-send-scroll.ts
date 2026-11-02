/** One scroll owner for the space opened by a send, including early reply growth.
 * The native animation supplies a scrub-able clock; rAF writes the real scroll
 * position so there is no jump to disguise with transforms on history rows.
 */
export class ChatSendScroll {
  private animation: Animation | undefined;
  private frame: number | undefined;
  private from: number;
  private target: number;
  private duration: number;
  private readonly initialDuration: number;
  private readonly anchoring: string;

  constructor(
    private readonly viewport: HTMLElement,
    from: number,
    duration: number,
    private readonly easing: string,
    private readonly settleDuration: number,
    private readonly settled: () => void,
  ) {
    this.from = from;
    this.target = this.end();
    this.duration = duration;
    this.initialDuration = duration;
    this.anchoring = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = 'none';
    viewport.scrollTop = from;
    this.start();
  }

  /** Resize/stream updates retarget from the current painted position. */
  reconcile(): void {
    if (!this.animation) return;
    const target = this.end();
    if (Math.abs(target - this.target) < 1) return;
    const elapsed = typeof this.animation.currentTime === 'number' ? this.animation.currentTime : 0;
    this.from = this.viewport.scrollTop;
    this.target = target;
    // A shrinking multi-line composer can keep changing the target throughout
    // the first curve. Do not compress a still-large remaining trip into 140ms.
    const travelDuration = Math.min(this.initialDuration, Math.abs(target - this.from) * 2);
    this.duration = Math.max(this.settleDuration, this.duration - elapsed, travelDuration);
    this.releaseAnimation();
    this.start();
  }

  cancel(): void {
    this.releaseAnimation();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.viewport.style.overflowAnchor = this.anchoring;
  }

  private end(): number {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
  }

  private start(): void {
    // This property is only a clock: its computed effect progress includes the
    // token easing, and native captures can pause/seek it with the bubble flight.
    this.animation = this.viewport.animate([
      { '--chat-send-progress': '0' }, { '--chat-send-progress': '1' },
    ], { duration: this.duration, easing: this.easing, fill: 'both' });
    this.animation.id = 'chat-send-scroll';
    this.animation.onfinish = () => {
      if (Math.abs(this.end() - this.target) >= 1) {
        this.reconcile();
        return;
      }
      this.viewport.scrollTop = this.target;
      this.cancel();
      this.settled();
    };
    if (this.frame === undefined) this.frame = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    this.frame = undefined;
    this.reconcile();
    if (!this.animation) return;
    const progress = this.animation.effect?.getComputedTiming().progress ?? 0;
    this.viewport.scrollTop = this.from + (this.target - this.from) * progress;
    this.frame = requestAnimationFrame(() => this.tick());
  }

  private releaseAnimation(): void {
    if (!this.animation) return;
    this.animation.onfinish = null;
    this.animation.cancel();
    this.animation = undefined;
  }
}
