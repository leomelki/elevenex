/** Aggregate delivery across subscribers. A slow passive viewer cannot reduce
 * quality for another viewer that keeps up. Missing an interframe after a drop
 * is decoder recovery, so the gateway does not count it as congestion. */
export class CaptureRate {
  private tier = 0;
  private samples = 0;
  private blocked = 0;
  private since = 0;
  private lastPressure = 0;

  get fpsScale(): number {
    return [1, 0.8, 0.6, 0.45][this.tier];
  }
  get bitrateScale(): number {
    return [1, 0.65, 0.4, 0.25][this.tier];
  }

  observe(sent: boolean, congested: boolean, now: number): boolean {
    if (!sent && !congested) return false;
    if (!this.samples) this.since = now;
    this.samples++;
    if (!sent && congested) this.blocked++;
    if (now - this.since < 3500) return false;
    const previous = this.tier;
    if (this.blocked >= 3 && this.blocked / this.samples >= 0.08) {
      this.lastPressure = now;
      this.tier = Math.min(3, this.tier + 1);
    } else if (
      !this.blocked &&
      this.samples >= 6 &&
      now - this.lastPressure >= 15000
    ) {
      this.tier = Math.max(0, this.tier - 1);
      if (this.tier !== previous) this.lastPressure = now;
    }
    this.samples = this.blocked = 0;
    return previous !== this.tier;
  }
}
