import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  videoEncoderArguments,
  type VideoEncoderTarget,
  type VideoFormat,
} from './runtime-video-profiles.js';

export interface EncodedBrowserVideo {
  readonly data: Buffer;
  readonly key: boolean;
}
export function videoProcessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // FFREPORT otherwise writes diagnostics to disk even at a fixed log level.
  delete environment['FFREPORT'];
  return environment;
}

/** One persistent encoder per visible presentation. No files, shell, audio or page URLs. */
export class RuntimeVideoEncoder {
  private readonly child;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private sizes = '';
  private packetSize = 0;
  private stopped = false;
  private pending?: {
    resolve(packet: EncodedBrowserVideo): void;
    reject(error: Error): void;
  };
  readonly closed: Promise<void>;

  constructor(target: VideoEncoderTarget, format: VideoFormat) {
    this.child = spawn(
      target.executable,
      videoEncoderArguments(target, format),
      {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: videoProcessEnvironment(),
      },
    );
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        this.stop();
        resolve();
      }),
    );
    this.child.once('error', () => this.stop());
    this.child.stdin.on('error', () => this.stop());
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.bytes + chunk.length > 3_000_000 || this.chunks.length >= 4096) {
        this.stop();
        return;
      }
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      this.flush();
    });
    // Diagnostics can contain arbitrary codec data. Drain them, never log them.
    this.child.stderr.resume();
    const metadata = this.child.stdio[3];
    if (!(metadata instanceof Readable)) {
      this.stop();
      return;
    }
    metadata.on('data', (chunk: Buffer) => {
      this.sizes += chunk.toString('ascii');
      if (this.sizes.length > 32) {
        this.stop();
        return;
      }
      const end = this.sizes.indexOf('\n');
      if (end < 0) return;
      const size = this.sizes.slice(0, end);
      this.sizes = this.sizes.slice(end + 1);
      if (
        this.packetSize ||
        !/^[1-9][0-9]{0,6}$/.test(size) ||
        Number(size) > 3_000_000
      ) {
        this.stop();
        return;
      }
      this.packetSize = Number(size);
      this.flush();
    });
  }
  private flush(): void {
    if (!this.packetSize || this.bytes < this.packetSize) return;
    // Only one input is submitted at a time. Extra output would violate access-
    // unit framing; reject it rather than corrupting a dependent video chain.
    if (this.bytes !== this.packetSize) {
      this.stop();
      return;
    }
    const data =
      this.chunks.length === 1
        ? this.chunks[0]
        : Buffer.concat(this.chunks, this.bytes);
    this.chunks.length = 0;
    this.bytes = 0;
    this.packetSize = 0;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) {
      this.stop();
      return;
    }
    let key = false;
    for (let i = 0; i + 4 < data.length; i++) {
      if (
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 1 &&
        (data[i + 3] & 31) === 5
      ) {
        key = true;
        break;
      }
    }
    pending.resolve({ data, key });
  }
  async encode(jpeg: Buffer, timeoutMs = 2000): Promise<EncodedBrowserVideo> {
    if (this.stopped || this.pending || jpeg.length > 3_000_000)
      throw new Error('Video encoder unavailable');
    const result = new Promise<EncodedBrowserVideo>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const timeout = setTimeout(() => this.stop(), timeoutMs);
    this.child.stdin.write(
      Buffer.concat([
        Buffer.from(
          `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
        ),
        jpeg,
        Buffer.from('\r\n'),
      ]),
    );
    try {
      return await result;
    } finally {
      clearTimeout(timeout);
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending?.reject(new Error('Video encoding interrupted'));
    this.pending = undefined;
    this.chunks.length = 0;
    this.bytes = 0;
    this.child.stdin.destroy();
    this.child.kill('SIGKILL');
  }
}
