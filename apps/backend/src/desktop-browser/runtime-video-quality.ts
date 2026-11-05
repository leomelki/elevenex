import type { VideoFormat } from './runtime-video-profiles.js';
import type {
  VideoResources,
  VideoSettings,
} from './runtime-video-resources.js';

/** Per-presentation feedback. Browser viewport and input coordinates never change. */
export class RuntimeVideoQuality {
  private encodeMs = 0;
  private samples = 0;
  private baselineRtt = Infinity;
  private readonly receipts: { time: number; milliseconds: number }[] = [];
  private congestion = 0;
  private tier = 0;
  private changed = -Infinity;
  private previous?: VideoFormat;
  private viewport = '';
  constructor(
    private readonly settings: VideoSettings,
    private readonly maximumWindow = 8,
  ) {}
  encoderStarted(): void {
    this.samples = 0;
    this.encodeMs = 0;
  }
  encoded(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    // Startup includes process/library initialization, not steady-state throughput.
    if (++this.samples < 3) return;
    this.encodeMs = this.encodeMs
      ? this.encodeMs * 0.85 + milliseconds * 0.15
      : milliseconds;
  }
  acknowledged(milliseconds: number, now = performance.now()): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    while (
      this.receipts.length &&
      (this.receipts[0].time < now - 20_000 || this.receipts.length >= 64)
    )
      this.receipts.shift();
    this.receipts.push({ time: now, milliseconds });
    this.baselineRtt = Math.min(
      ...this.receipts.map((receipt) => receipt.milliseconds),
    );
    this.congestion =
      milliseconds > this.baselineRtt + 150
        ? this.congestion + 1
        : Math.max(0, this.congestion - 1);
    if (this.congestion >= 3 && now - this.changed > 2000) {
      this.tier = Math.min(5, this.tier + 1);
      this.changed = now;
      this.congestion = 0;
    } else if (
      !this.congestion &&
      this.tier > 0 &&
      now - this.changed > 10_000
    ) {
      this.tier--;
      this.changed = now;
    }
  }
  window(maximum: number, fps: number): number {
    return Math.max(
      2,
      Math.min(
        maximum,
        Number.isFinite(this.baselineRtt)
          ? Math.ceil((this.baselineRtt * fps) / 1000) + 1
          : 3,
      ),
    );
  }
  select(
    viewport: { width: number; height: number; pixelRatio?: number },
    hardware: boolean,
    resources: VideoResources,
    viewers: number,
    now = performance.now(),
  ): VideoFormat {
    const viewportKey = `${viewport.width}:${viewport.height}:${viewport.pixelRatio ?? 1}`;
    if (viewportKey !== this.viewport) {
      this.previous = undefined;
      this.viewport = viewportKey;
    }
    const count = Math.max(1, viewers),
      cores = Math.max(0.1, resources.cores);
    const pressure =
      resources.busy > 0.9 ? 0.5 : resources.busy > 0.75 ? 0.75 : 1;
    const pixelsPerSecond = Math.max(
      300_000,
      ((hardware ? 60_000_000 : 18_000_000) *
        Math.min(4, cores * 0.5) *
        pressure) /
        count,
    );
    let fps = Math.max(
      2,
      Math.floor(
        Math.min(
          this.settings.maxFps,
          hardware ? 60 : 30,
          this.encodeMs ? 700 / this.encodeMs : 60,
          Number.isFinite(this.baselineRtt)
            ? ((this.maximumWindow - 1) * 1000) / Math.max(1, this.baselineRtt)
            : 60,
        ) *
          0.8 ** this.tier,
      ),
    );
    let scale = Math.min(
      viewport.pixelRatio ?? 1,
      this.settings.maxWidth / viewport.width,
      this.settings.maxHeight / viewport.height,
    );
    // Preserve useful text resolution before pushing CPU-only streams to high FPS.
    if (!hardware)
      scale = Math.min(scale, 1280 / viewport.width, 720 / viewport.height);
    const requestedPixels = viewport.width * viewport.height * scale * scale;
    fps = Math.max(
      Math.min(fps, hardware ? 15 : 10),
      Math.min(fps, Math.floor(pixelsPerSecond / requestedPixels)),
    );
    const memoryPixels = resources.memory / (count * 48);
    scale = Math.min(
      scale,
      Math.sqrt(
        Math.min(pixelsPerSecond / fps, memoryPixels) /
          (viewport.width * viewport.height),
      ),
    );
    const desiredWidth = viewport.width * scale;
    const widths = [1920, 1600, 1280, 960, 800, 640, 480, 320, 160];
    const boundedWidth =
      widths.find((width) => width <= desiredWidth) ??
      Math.max(16, Math.floor(desiredWidth / 2) * 2);
    scale = Math.min(scale, boundedWidth / viewport.width);
    let width = Math.max(16, Math.floor((viewport.width * scale) / 2) * 2);
    let height = Math.max(16, Math.floor((viewport.height * scale) / 2) * 2);
    const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    if (macroblocks > 8704) {
      const shrink = Math.sqrt(8704 / macroblocks) * 0.99;
      width = Math.max(16, Math.floor((width * shrink) / 16) * 16);
      height = Math.max(16, Math.floor((height * shrink) / 16) * 16);
    }
    const previous = this.previous;
    // Fast reductions, slow recovery: CPU/memory fluctuations must not repeatedly
    // restart encoders and flood the network with larger keyframes.
    if (previous && width > previous.width && now - this.changed < 10_000) {
      width = previous.width;
      height = previous.height;
    }
    if (!previous || width < previous.width || height < previous.height)
      this.changed = now;
    // H.264 level 4.2 constrains macroblocks/second, including retina/tall viewports.
    fps = Math.min(
      fps,
      Math.max(
        1,
        Math.floor(522240 / (Math.ceil(width / 16) * Math.ceil(height / 16))),
      ),
    );
    fps =
      [60, 45, 30, 24, 20, 15, 10, 8, 5, 2, 1].find((rate) => rate <= fps) ?? 1;
    const targetBitrate = Math.max(
      250_000,
      Math.min(
        this.settings.maxBitrate,
        width * height * fps * 0.14 * 0.85 ** this.tier,
      ),
    );
    const bitrate = Math.max(
      250_000,
      Math.floor(targetBitrate / 250_000) * 250_000,
    );
    const result = {
      width,
      height,
      fps,
      bitrate,
      threads: Math.max(
        1,
        Math.min(this.settings.threads, Math.floor((cores * 0.5) / count)),
      ),
    };
    this.previous = result;
    return result;
  }
}
