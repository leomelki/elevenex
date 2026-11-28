import { VIDEO_RESOLUTION_SCALES } from '../desktop-browser/video-delivery.js';

const sampleGapMs = 3000;
const downgradeWindowMs = 750;
const recoveryWindowMs = 15_000;

/** Aggregate delivery across subscribers. A slow passive viewer cannot reduce
 * quality for another viewer that keeps up. Missing an interframe after a drop
 * is decoder recovery, so the gateway does not count it as congestion. */
export class CaptureRate {
  private tier = 0;
  private samples = 0;
  private blocked = 0;
  private since = 0;
  private lastSample = -Infinity;
  private healthySince?: number;

  get fpsScale(): number {
    return [1, 0.8, 0.65, 0.5, 0.35, 0.25][this.tier];
  }
  get bitrateScale(): number {
    return [1, 0.65, 0.5, 0.4, 0.3, 0.25][this.tier];
  }
  get resolutionScale(): number {
    return VIDEO_RESOLUTION_SCALES[this.tier];
  }

  observe(sent: boolean, congested: boolean, now: number): boolean {
    if (!sent && !congested) return false;
    // Static windows suppress duplicates. Measure the gap between samples so
    // sparse, regular pressure survives, while unrelated idle bursts do not.
    if (now - this.lastSample > sampleGapMs) {
      this.samples = this.blocked = 0;
      this.healthySince = undefined;
    }
    this.lastSample = now;
    if (!this.samples) this.since = now;
    this.samples++;
    if (sent) this.healthySince ??= now;
    else {
      this.blocked++;
      this.healthySince = undefined;
    }
    if (this.samples < 3 || now - this.since < downgradeWindowMs) return false;
    const previous = this.tier;
    if (this.blocked >= 3 && this.blocked / this.samples >= 0.08) {
      this.tier = Math.min(VIDEO_RESOLUTION_SCALES.length - 1, this.tier + 1);
    } else if (
      this.tier > 0 &&
      this.healthySince !== undefined &&
      now - this.healthySince >= recoveryWindowMs
    ) {
      this.tier--;
      this.healthySince = now;
    }
    this.samples = this.blocked = 0;
    return previous !== this.tier;
  }
}
