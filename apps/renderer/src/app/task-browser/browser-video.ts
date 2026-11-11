import type { TaskBrowserFrame } from "@elevenex/shared";

/** Validate baseline SPS dimensions before handing untrusted bytes to the decoder. */
export function browserVideoSize(
  data: Uint8Array,
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
    if (width > 1920 || height > 1440 || width < 16 || height < 16) return null;
    const cropped = {
      width: width - 2 * (left + right),
      height: height - 2 * (top + bottom),
    };
    return cropped.width > 0 && cropped.height > 0 ? cropped : null;
  } catch {
    return null;
  }
}

/** One decoder and one pending output. Owner draws and closes every returned frame. */
export class BrowserVideoDecoder {
  private decoder?: VideoDecoder;
  private epoch = "";
  private pending?: {
    resolve(frame: VideoFrame): void;
    reject(error: Error): void;
  };
  private disposed = false;
  private revision = 0;
  private support?: { cancel(): void };
  async decode(
    video: NonNullable<TaskBrowserFrame["video"]>,
  ): Promise<VideoFrame> {
    if (
      this.disposed ||
      this.pending ||
      this.support ||
      typeof VideoDecoder === "undefined" ||
      video.data.byteLength > 3_000_000 ||
      video.codec !== "avc1.42E02A"
    )
      throw new Error("Video decoder unavailable");
    // Only a key access unit may introduce exactly one validated SPS. A delta
    // must never smuggle replacement allocation parameters into the decoder.
    let parameters = 0;
    for (let i = 0; i + 4 < video.data.length; i++) {
      if (
        video.data[i] === 0 &&
        video.data[i + 1] === 0 &&
        video.data[i + 2] === 1 &&
        (video.data[i + 3]! & 31) === 7
      ) {
        if (
          !video.key ||
          ++parameters > 1 ||
          !browserVideoSize(video.data.subarray(i))
        )
          throw new Error("Invalid video parameters");
      }
    }
    if (video.epoch !== this.epoch) {
      if (!video.key || !browserVideoSize(video.data))
        throw new Error("Invalid video keyframe");
      this.reset();
      const revision = this.revision;
      const config: VideoDecoderConfig = {
        codec: video.codec,
        optimizeForLatency: true,
      };
      if (
        !(await this.checkSupport(config)) ||
        this.disposed || revision !== this.revision
      )
        throw new Error("Video codec unavailable");
      this.decoder = new VideoDecoder({
        output: (frame) => {
          if (revision !== this.revision || this.disposed) { frame.close(); return; }
          const pending = this.pending;
          this.pending = undefined;
          if (pending) pending.resolve(frame);
          else frame.close();
        },
        error: () => { if (revision === this.revision) this.reset(); },
      });
      this.decoder.configure(config);
      this.epoch = video.epoch;
    } else if (video.key && !browserVideoSize(video.data))
      throw new Error("Invalid video keyframe");
    const result = new Promise<VideoFrame>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const timer = setTimeout(() => this.reset(), 2000);
    try {
      try {
        this.decoder!.decode(
          new EncodedVideoChunk({
            type: video.key ? "key" : "delta",
            timestamp: video.timestamp,
            data: video.data.slice(),
          }),
        );
      } catch {
        this.reset();
      }
      return await result;
    } finally {
      clearTimeout(timer);
    }
  }
  private async checkSupport(config: VideoDecoderConfig): Promise<boolean> {
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('Video codec unavailable'));
    });
    const pending = { cancel };
    this.support = pending;
    // A hung GPU capability query precedes decode's own deadline. Without this
    // boundary it holds the paint lane even across stream resets and JPEG recovery.
    const timer = setTimeout(cancel, 2000);
    try {
      return (await Promise.race([VideoDecoder.isConfigSupported(config), cancelled])).supported === true;
    } finally {
      clearTimeout(timer);
      if (this.support === pending) this.support = undefined;
    }
  }
  reset(): void {
    this.revision++;
    this.support?.cancel();
    this.support = undefined;
    this.pending?.reject(new Error("Video decoding interrupted"));
    this.pending = undefined;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
    this.epoch = "";
  }
  destroy(): void {
    this.disposed = true;
    this.reset();
  }
}
