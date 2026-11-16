import { RuntimeVideoCatalog } from './runtime-video-catalog.js';
import {
  RuntimeVideoResources,
  videoSettings,
  type VideoSettings,
} from './runtime-video-resources.js';
import { RuntimeVideoEncoder } from './runtime-video-encoder.js';
import {
  videoTargetId,
  type VideoEncoderTarget,
} from './runtime-video-profiles.js';

interface Work {
  readonly signal: AbortSignal;
  start(): void;
  cancel(): void;
}
/** Application media lifetime: capability cache, fair CPU work admission and encoder cleanup. */
export class RuntimeVideoHost {
  readonly settings: VideoSettings;
  readonly resources = new RuntimeVideoResources();
  readonly catalog: RuntimeVideoCatalog;
  private readonly viewers = new Set<symbol>();
  private readonly encoders = new Set<RuntimeVideoEncoder>();
  private readonly devices = new Map<string, number>();
  private readonly work: Work[] = [];
  private running = 0;
  private stopped = false;
  constructor(settings = videoSettings()) {
    this.settings = settings;
    this.catalog = new RuntimeVideoCatalog(settings);
  }
  get count(): number {
    return this.viewers.size;
  }
  register(): () => void {
    if (this.stopped || this.viewers.size >= 48)
      throw new Error('Video presentation limit reached');
    const id = Symbol();
    this.viewers.add(id);
    return () => this.viewers.delete(id);
  }
  async select(
    signal: AbortSignal,
    excluded: ReadonlySet<string>,
  ): Promise<VideoEncoderTarget> {
    await this.resources.ready();
    const targets = [...(await this.catalog.targets())].sort(
        (a, b) =>
          Number(a.kind === 'software') - Number(b.kind === 'software') ||
          (this.devices.get(this.deviceId(a)) ?? 0) -
            (this.devices.get(this.deviceId(b)) ?? 0),
      ),
      deadline = performance.now() + 2500;
    for (const target of targets) {
      signal.throwIfAborted();
      if (this.stopped) throw new Error('Video host stopped');
      if (
        excluded.has(videoTargetId(target)) ||
        (target.kind !== 'software' && performance.now() > deadline)
      )
        continue;
      if (await this.catalog.usable(target)) {
        signal.throwIfAborted();
        return target;
      }
    }
    throw new Error('No usable video encoder');
  }
  private deviceId(target: VideoEncoderTarget): string {
    return target.device?.startsWith('/dev/dri/')
      ? target.device
      : `${target.kind}:${target.device ?? 'default'}`;
  }
  own(encoder: RuntimeVideoEncoder, target: VideoEncoderTarget): void {
    if (this.stopped) {
      encoder.stop();
      throw new Error('Video host stopped');
    }
    this.encoders.add(encoder);
    const device = this.deviceId(target);
    this.devices.set(device, (this.devices.get(device) ?? 0) + 1);
    void encoder.closed.finally(() => {
      this.encoders.delete(encoder);
      const remaining = (this.devices.get(device) ?? 1) - 1;
      if (remaining) this.devices.set(device, remaining);
      else this.devices.delete(device);
    });
  }
  async encode(
    encoder: Pick<RuntimeVideoEncoder, 'encode'>,
    jpeg: Buffer,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<RuntimeVideoEncoder['encode']>>> {
    return this.schedule(() => encoder.encode(jpeg), signal);
  }
  private schedule<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.stopped || this.work.length >= 48)
      return Promise.reject(new Error('Video work capacity reached'));
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.work.indexOf(entry);
        if (index >= 0) this.work.splice(index, 1);
        signal.removeEventListener('abort', cancel);
        reject(new Error('Video work interrupted'));
      };
      const entry: Work = {
        signal,
        cancel,
        start: () => {
          signal.removeEventListener('abort', cancel);
          this.running++;
          void operation()
            .then(resolve, reject)
            .finally(() => {
              this.running--;
              this.drain();
            });
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.work.push(entry);
      this.drain();
    });
  }
  private drain(): void {
    const limit = Math.max(
      1,
      Math.min(4, Math.floor(this.resources.snapshot().cores / 2)),
    );
    while (!this.stopped && this.work.length && this.running < limit) {
      const next = this.work.shift()!;
      if (next.signal.aborted) next.cancel();
      else next.start();
    }
  }
  async destroy(): Promise<void> {
    this.stopped = true;
    for (const entry of [...this.work]) entry.cancel();
    for (const encoder of this.encoders) encoder.stop();
    await Promise.allSettled(
      [...this.encoders].map((encoder) => encoder.closed),
    );
    await this.catalog.destroy();
    this.viewers.clear();
  }
}
