// Bound the bytes committed to reliable transport before another frame can
// replace them. A single access unit may exceed this soft limit.
export const VIDEO_PENDING_BYTES = 192 * 1024;
export const VIDEO_RESOLUTION_SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3] as const;

/** Recent send-to-paint RTT, including desktop decoding and presentation. */
export class VideoDeliveryLatency {
  private readonly minima: { second: number; milliseconds: number }[] = [];
  private minimum = Infinity;

  acknowledge(milliseconds: number, now: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const second = Math.floor(now / 1000);
    while (this.minima.length && this.minima[0].second <= second - 20)
      this.minima.shift();
    const last = this.minima.at(-1);
    if (last?.second === second)
      last.milliseconds = Math.min(last.milliseconds, milliseconds);
    else this.minima.push({ second, milliseconds });
    this.minimum = Math.min(...this.minima.map((sample) => sample.milliseconds));
  }

  get baseline(): number {
    return this.minimum;
  }

  overdue(milliseconds: number): boolean {
    const deadline = Number.isFinite(this.minimum)
      ? this.minimum + Math.max(80, Math.min(150, this.minimum / 2))
      : 600;
    return milliseconds > deadline;
  }
}
