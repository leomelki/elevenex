export interface H264Packet {
  readonly codec: "avc1.42E02A";
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly timestamp: number;
  readonly epoch: string;
}
export interface VideoLimits { readonly width: number; readonly height: number; readonly pixels: number }
const browserLimits: VideoLimits = { width: 1920, height: 1440, pixels: 1920 * 1440 };

/** Validate baseline SPS dimensions before handing untrusted bytes to the decoder. */
export function h264Size(
  data: Uint8Array, limits: VideoLimits = browserLimits,
): { width: number; height: number } | null {
  try {
    let start = -1;
    for (let i = 0; i + 4 < Math.min(data.length, 65536); i++) {
      if (
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 1 &&
        (data[i + 3]! & 31) === 7
      ) {
        start = i + 4;
        break;
      }
    }
    if (start < 0) return null;
    const bytes: number[] = [];
    for (let i = start; i < Math.min(data.length, start + 256); i++) {
      if (
        i >= start + 2 &&
        data[i] === 3 &&
        data[i - 1] === 0 &&
        data[i - 2] === 0
      )
        continue;
      bytes.push(data[i]!);
    }
    let bit = 0;
    const read = (count = 1): number => {
      if (count > 24 || bit + count > bytes.length * 8) throw new Error();
      let value = 0;
      for (let n = 0; n < count; n++, bit++)
        value = value * 2 + ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
      return value;
    };
    const unsigned = (): number => {
      let zeros = 0;
      while (read() === 0) if (++zeros > 20) throw new Error();
      return 2 ** zeros - 1 + read(zeros);
    };
    if (read(8) !== 66) return null; // Negotiated baseline; no high-profile scaling lists.
    read(8);
    read(8);
    unsigned();
    if (unsigned() > 12) return null;
    const order = unsigned();
    if (order === 0) {
      if (unsigned() > 12) return null;
    } else if (order !== 2) return null;
    if (unsigned() > 4) return null;
    read();
    const width = (unsigned() + 1) * 16;
    const rows = unsigned() + 1,
      progressive = read();
    if (!progressive) return null;
    const height = rows * 16;
    read();
    let left = 0,
      right = 0,
      top = 0,
      bottom = 0;
    if (read()) {
      left = unsigned();
      right = unsigned();
      top = unsigned();
      bottom = unsigned();
    }
    if (width > limits.width || height > limits.height || width * height > limits.pixels || width < 16 || height < 16) return null;
    const cropped = {
      width: width - 2 * (left + right),
      height: height - 2 * (top + bottom),
    };
    return cropped.width > 0 && cropped.height > 0 ? cropped : null;
  } catch {
    return null;
  }
}

/** One bounded decoder pipeline. Owners draw and close every returned frame. */
export class H264Decoder {
  constructor(
    private readonly limits: VideoLimits = browserLimits,
    private readonly acceleration: HardwareAcceleration = "no-preference",
  ) {}
  private decoder?: VideoDecoder;
  private epoch = "";
  private readonly pending = new Map<number, {
    resolve(frame: VideoFrame): void;
    reject(error: Error): void;
    timer?: ReturnType<typeof setTimeout>;
    bytes: number;
  }>();
  private queuedBytes = 0;
  private nextTimestamp = 0;
  private submissions: Promise<void> = Promise.resolve();
  private disposed = false;
  private revision = 0;
  private support?: { cancel(): void };

  decode(video: H264Packet): Promise<VideoFrame> {
    try {
      if (this.disposed || typeof VideoDecoder === "undefined" || video.data.byteLength > 3_000_000 || video.codec !== "avc1.42E02A")
        throw new Error("Video decoder unavailable");
      // Only a key access unit may introduce exactly one validated SPS. A delta
      // must never smuggle replacement allocation parameters into the decoder.
      let parameters = 0;
      for (let i = 0; i + 4 < video.data.length; i++) {
        if (video.data[i] === 0 && video.data[i + 1] === 0 && video.data[i + 2] === 1 && (video.data[i + 3]! & 31) === 7) {
          if (!video.key || ++parameters > 1 || !h264Size(video.data.subarray(i), this.limits))
            throw new Error("Invalid video parameters");
        }
      }
      if (video.epoch !== this.epoch) {
        if (!video.key || !h264Size(video.data, this.limits)) throw new Error("Invalid video keyframe");
        this.reset();
        this.epoch = video.epoch;
      } else if (video.key && !h264Size(video.data, this.limits)) throw new Error("Invalid video keyframe");
      if (this.pending.size >= 8 || this.queuedBytes + video.data.byteLength > 3_000_000)
        throw new Error("Video decoder queue exceeded its budget");
    } catch (error) { return Promise.reject(error); }

    const revision = this.revision;
    // Decoder-local timestamps uniquely match outputs even if host timestamps
    // coincide. They are private bookkeeping, not playback timing.
    const timestamp = ++this.nextTimestamp;
    const result = new Promise<VideoFrame>((resolve, reject) => {
      this.pending.set(timestamp, { resolve, reject, bytes: video.data.byteLength });
      this.queuedBytes += video.data.byteLength;
    });
    // Serialize configuration and submission, not output. VideoToolbox may
    // retain a frame until the next chunk arrives even with optimizeForLatency.
    this.submissions = this.submissions.then(async () => {
      if (revision !== this.revision || this.disposed) return;
      if (!this.decoder) {
        const config = await this.selectConfig(video.codec, revision);
        if (!config || this.disposed || revision !== this.revision)
          throw new Error("Video codec unavailable");
        this.decoder = new VideoDecoder({
          output: frame => {
            if (revision !== this.revision || this.disposed) { frame.close(); return; }
            const pending = this.pending.get(frame.timestamp);
            if (!pending) { frame.close(); return; }
            this.pending.delete(frame.timestamp);
            this.queuedBytes -= pending.bytes;
            clearTimeout(pending.timer);
            pending.resolve(frame);
          },
          error: () => { if (revision === this.revision) this.reset(); },
        });
        this.decoder.configure(config);
      }
      const pending = this.pending.get(timestamp);
      if (!pending) return;
      pending.timer = setTimeout(() => this.reset(), 2000);
      this.decoder.decode(new EncodedVideoChunk({ type: video.key ? "key" : "delta", timestamp, data: video.data.slice() }));
    }).catch(error => { if (revision === this.revision) this.reset(error instanceof Error ? error : undefined); });
    return result;
  }

  private async selectConfig(codec: H264Packet["codec"], revision: number): Promise<VideoDecoderConfig | undefined> {
    const config: VideoDecoderConfig = { codec, optimizeForLatency: true };
    const probe = async () => {
      if (this.acceleration !== "no-preference") {
        const preferred = { ...config, hardwareAcceleration: this.acceleration };
        if ((await VideoDecoder.isConfigSupported(preferred)).supported) return preferred;
        if (revision !== this.revision) return undefined;
      }
      return (await VideoDecoder.isConfigSupported(config)).supported ? config : undefined;
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('Video codec unavailable'));
    });
    const pending = { cancel };
    this.support = pending;
    const timer = setTimeout(cancel, 2000);
    try {
      return await Promise.race([probe(), cancelled]);
    } finally {
      clearTimeout(timer);
      if (this.support === pending) this.support = undefined;
    }
  }
  reset(reason = new Error("Video decoding interrupted")): void {
    this.revision++;
    this.support?.cancel();
    this.support = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
    this.queuedBytes = 0;
    this.submissions = Promise.resolve();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
    this.epoch = "";
  }
  destroy(): void { this.disposed = true; this.reset(); }
}
