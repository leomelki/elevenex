import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeBrowserTab } from './runtime-tab.js';
import {
  RuntimeVideoEncoder,
  type EncodedBrowserVideo,
} from './runtime-video-encoder.js';
import { RuntimeVideoHost } from './runtime-video-host.js';
import { RuntimeVideoQuality } from './runtime-video-quality.js';
import {
  videoTargetId,
  type VideoEncoderTarget,
  type VideoFormat,
} from './runtime-video-profiles.js';

export interface RuntimeVideoPacket {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly displayEpoch?: number;
  readonly video: {
    readonly epoch: string;
    readonly codec: 'avc1.42E02A';
    readonly key: boolean;
    readonly timestamp: number;
    readonly data: Buffer;
  };
}
export interface RuntimeVideoOptions {
  readonly host?: RuntimeVideoHost;
  readonly maxInFlight?: number;
  readonly bufferedBytes?: () => number;
}

/** Presentation lifetime and feedback. The host owns shared capabilities and work admission. */
export class RuntimeBrowserVideo {
  private readonly lifetime = new AbortController();
  private encoder?: RuntimeVideoEncoder;
  private readonly outstanding = new Map<
    number,
    { sent: number; bytes: number }
  >();
  private wake?: () => void;
  private sequence = 0;
  private fps = 30;
  private readonly host: RuntimeVideoHost;
  private readonly quality: RuntimeVideoQuality;
  private readonly maximumWindow: number;
  readonly done: Promise<void>;
  constructor(
    tab: Pick<RuntimeBrowserTab, 'nextFrame'>,
    current: () => boolean,
    send: (packet: RuntimeVideoPacket) => void,
    private readonly options: RuntimeVideoOptions = {},
  ) {
    this.host = options.host ?? new RuntimeVideoHost();
    this.maximumWindow = Math.max(3, Math.min(8, options.maxInFlight ?? 3));
    this.quality = new RuntimeVideoQuality(
      this.host.settings,
      this.maximumWindow,
    );
    const unregister = this.host.register();
    this.done = this.run(tab, current, send)
      .catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) throw error;
      })
      .finally(async () => {
        this.stop();
        await this.encoder?.closed;
        unregister();
        if (!options.host) await this.host.destroy();
      });
  }
  acknowledge(sequence: number): void {
    if (sequence > this.sequence)
      throw new Error('Invalid video acknowledgment');
    const now = performance.now();
    const receipt = this.outstanding.get(sequence);
    if (receipt) this.quality.acknowledged(now - receipt.sent, now);
    for (const id of this.outstanding.keys())
      if (id <= sequence) this.outstanding.delete(id);
    this.wake?.();
  }
  stop(): void {
    this.lifetime.abort();
    this.encoder?.stop();
    this.wake?.();
  }
  private async pause(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }
  private async run(
    tab: Pick<RuntimeBrowserTab, 'nextFrame'>,
    current: () => boolean,
    send: (packet: RuntimeVideoPacket) => void,
  ): Promise<void> {
    let after = 0,
      epoch = randomUUID(),
      lastCapture = 0,
      lastRestart = -Infinity,
      displayEpoch: number | undefined;
    let target: VideoEncoderTarget | undefined, format: VideoFormat | undefined;
    const excluded = new Set<string>(),
      started = performance.now();
    while (!this.lifetime.signal.aborted && current()) {
      const now = performance.now();
      if (
        [...this.outstanding.values()].some(
          (receipt) => now - receipt.sent > 15000,
        )
      )
        throw new Error('Video viewer stalled');
      if (
        this.outstanding.size >=
          this.quality.window(this.maximumWindow, this.fps) ||
        [...this.outstanding.values()].reduce(
          (sum, receipt) => sum + receipt.bytes,
          0,
        ) >= 3_000_000 ||
        (this.options.bufferedBytes?.() ?? 0) > 512 * 1024
      ) {
        await this.pause();
        continue;
      }
      const pause = 1000 / this.fps - (now - lastCapture);
      if (pause > 0)
        await delay(pause, undefined, { signal: this.lifetime.signal });
      // Discovery can be slow on a cold host. Capture after it finishes so the
      // first video packet cannot replace the bootstrap with older pixels.
      target ??= await this.host.select(this.lifetime.signal, excluded);
      if (!current() || this.lifetime.signal.aborted) return;
      const frame = await tab.nextFrame(
        after,
        this.lifetime.signal,
        1000,
        format
          ? { width: format.width, height: format.height, fps: this.fps }
          : true,
      );
      if (!current() || this.lifetime.signal.aborted) return;
      if (!frame) {
        // A starting or hidden tab can resolve immediately. Yield to I/O and
        // timers so an unavailable source cannot starve heartbeats or stop().
        await this.pause();
        continue;
      }
      lastCapture = performance.now();
      after = frame.sequence;
      const changedDocument = frame.displayEpoch !== displayEpoch;
      displayEpoch = frame.displayEpoch;
      // Failure never drops an encoded dependent packet: a replacement encoder
      // creates a fresh keyframe epoch for this same most-recent source image.
      for (;;) {
        this.lifetime.signal.throwIfAborted();
        target ??= await this.host.select(this.lifetime.signal, excluded);
        if (!current()) return;
        const desired = this.quality.select(
          frame,
          target.kind !== 'software',
          this.host.resources.snapshot(),
          this.host.count,
        );
        this.fps = desired.fps;
        const resized =
          !format ||
          format.width !== desired.width ||
          format.height !== desired.height;
        const retune =
          format &&
          (format.bitrate !== desired.bitrate ||
            format.threads !== desired.threads) &&
          performance.now() - lastRestart > 3000;
        if (!this.encoder || resized || retune || changedDocument) {
          this.encoder?.stop();
          await this.encoder?.closed;
          format = desired;
          epoch = randomUUID();
          lastRestart = performance.now();
          this.encoder = new RuntimeVideoEncoder(target, format);
          this.quality.encoderStarted();
          this.host.own(this.encoder, target);
        }
        let packet: EncodedBrowserVideo;
        try {
          const encoding = performance.now();
          packet = await this.host.encode(
            this.encoder,
            frame.jpeg,
            this.lifetime.signal,
          );
          this.quality.encoded(performance.now() - encoding);
        } catch (error) {
          if (this.lifetime.signal.aborted) throw error;
          this.host.catalog.reject(target);
          excluded.add(videoTargetId(target));
          this.encoder.stop();
          await this.encoder.closed;
          this.encoder = undefined;
          target = undefined;
          format = undefined;
          continue;
        }
        if (!current() || this.lifetime.signal.aborted) return;
        const sequence = ++this.sequence;
        this.outstanding.set(sequence, {
          sent: performance.now(),
          bytes: packet.data.length,
        });
        send({
          sequence,
          width: frame.width,
          height: frame.height,
          ...(frame.displayEpoch === undefined ? {} : { displayEpoch: frame.displayEpoch }),
          video: {
            epoch,
            codec: 'avc1.42E02A',
            key: packet.key,
            timestamp: Math.round((performance.now() - started) * 1000),
            data: packet.data,
          },
        });
        break;
      }
    }
  }
}
