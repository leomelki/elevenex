import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { RuntimeVideoHost } from '../desktop-browser/runtime-video-host.js';
import {
  videoTargetId,
  videoEncoderArguments,
  type VideoEncoderTarget,
} from '../desktop-browser/runtime-video-profiles.js';
import { CaptureRate } from './capture-rate.js';
import { managedVideoExecutable } from '../desktop-browser/runtime-video-catalog.js';
import type { AppDisplaySize } from './app-display-size.js';

const FRAME_LIMIT = 3_000_000;

export interface AppFrame {
  data: Buffer;
  key: boolean;
  width: number;
  height: number;
  timestamp: number;
  codec: 'avc1.42E02A';
}

export type AppStreamEnd = 'permission' | 'window-changed' | 'window-missing';
export interface AppFrameListener {
  frame(frame: AppFrame): boolean | void;
  end(reason: string, disposition?: AppStreamEnd): void;
}

/** The packet-size pipe and the H.264 pipe can arrive in either order. */
export class AppPacketReader {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private sizes: number[] = [];
  private text = '';

  constructor(private readonly emit: (packet: Buffer) => void) {}

  data(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > FRAME_LIMIT * 2 || this.chunks.length >= 256)
      throw new Error('App capture exceeded its byte budget');
    this.chunks.push(chunk);
    this.drain();
  }

  metadata(chunk: Buffer): void {
    this.text += chunk.toString('ascii');
    const lines = this.text.split('\n');
    this.text = lines.pop()!;
    if (this.text.length > 7 || lines.length + this.sizes.length > 256)
      throw new Error('Invalid capture packet boundaries');
    for (const line of lines) {
      if (!/^[1-9]\d{0,6}$/.test(line) || Number(line) > FRAME_LIMIT)
        throw new Error('Invalid capture packet size');
      this.sizes.push(Number(line));
    }
    this.drain();
  }

  private drain(): void {
    while (this.sizes.length && this.bytes >= this.sizes[0]) {
      const size = this.sizes.shift()!;
      const first = this.chunks[0];
      let packet: Buffer;
      if (first.length >= size) {
        packet = first.subarray(0, size);
        if (size === first.length) this.chunks.shift();
        else this.chunks[0] = first.subarray(size);
      } else {
        packet = Buffer.allocUnsafe(size);
        for (let offset = 0; offset < size; ) {
          const chunk = this.chunks[0];
          const taken = Math.min(size - offset, chunk.length);
          chunk.copy(packet, offset, 0, taken);
          offset += taken;
          if (taken === chunk.length) this.chunks.shift();
          else this.chunks[0] = chunk.subarray(taken);
        }
      }
      this.bytes -= size;
      this.emit(packet);
    }
  }
}

const startCode = Buffer.from([0, 0, 1]);
function isIdr(packet: Buffer): boolean {
  let start = packet.indexOf(startCode);
  while (start >= 0 && start + 3 < packet.length) {
    const type = packet[start + 3] & 31;
    if (type === 5) return true;
    if (type === 1) return false;
    start = packet.indexOf(startCode, start + 3);
  }
  return false;
}

/** Captures one run's private display once, regardless of the number of viewers. */
export class DisplayCapture {
  private readonly listeners = new Map<AppFrameListener, boolean>();
  private child?: ChildProcess;
  private rate = new CaptureRate();
  private readonly excluded = new Set<string>();
  private watchLifetime?: AbortController;
  private unregister?: () => void;
  private readonly software: VideoEncoderTarget = {
    kind: 'software',
    executable: managedVideoExecutable(),
  };

  constructor(
    private readonly source: {
      input(fps: number): string[];
      restartable: boolean;
      env: NodeJS.ProcessEnv;
      width: number;
      height: number;
    },
    private readonly host: RuntimeVideoHost,
  ) {}

  static x11(
    display: string,
    authority: string,
    host: RuntimeVideoHost,
    size: AppDisplaySize,
  ): DisplayCapture {
    return new DisplayCapture(
      {
        restartable: true,
        input: (fps) => [
          '-f',
          'x11grab',
          '-framerate',
          String(fps),
          '-video_size',
          `${size.width}x${size.height}`,
          '-draw_mouse',
          '1',
          '-probesize',
          '32',
          '-analyzeduration',
          '0',
          '-i',
          display,
        ],
        env: { DISPLAY: display, XAUTHORITY: authority, LC_ALL: 'C' },
        width: size.width,
        height: size.height,
      },
      host,
    );
  }

  watch(listener: AppFrameListener): () => void {
    if (this.listeners.size >= 8) throw new Error('Too many app viewers');
    this.listeners.set(listener, false);
    try {
      if (!this.watchLifetime) {
        this.unregister = this.host.register();
        const lifetime = new AbortController();
        this.watchLifetime = lifetime;
        this.excluded.clear();
        this.rate = new CaptureRate();
        this.start(this.software);
        const initial = this.child;
        // Hardware probes coalesce with Browser. Do not hold up the first
        // software frame on a cold host or switch a single-use Windows pipe.
        if (
          this.source.restartable &&
          this.host.settings.encoder !== 'software'
        ) {
          void this.host
            .select(lifetime.signal, this.excluded)
            .then((target) => {
              if (
                lifetime.signal.aborted ||
                this.child !== initial ||
                target.kind === 'software'
              )
                return;
              this.replaceEncoder(target);
            })
            .catch(() => {
              if (!this.child && !lifetime.signal.aborted)
                this.close('App encoder unavailable');
            });
        }
      }
    } catch (error) {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.close('App encoder unavailable');
      throw error;
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.close('View closed');
    };
  }

  private replaceEncoder(target: VideoEncoderTarget): void {
    this.child?.kill('SIGKILL');
    this.child = undefined;
    for (const subscriber of this.listeners.keys())
      this.listeners.set(subscriber, false);
    this.start(target);
  }

  private start(target: VideoEncoderTarget): void {
    const software = target.kind === 'software';
    const resources = this.host.resources.snapshot();
    const share = resources.cores / Math.max(1, this.host.count);
    const capacityFps = this.source.restartable
      ? Math.min(
          this.host.settings.maxFps,
          software
            ? share < 1.5 ||
              resources.memory < 512 * 1024 * 1024 ||
              resources.busy > 0.9
              ? 15
              : share < 3 && this.source.width * this.source.height > 1280 * 800
                ? 24
                : 30
            : share < 1.5
              ? 30
              : 60,
        )
      : 30;
    const fps = Math.max(5, Math.floor(capacityFps * this.rate.fpsScale));
    const bitrate = Math.min(
      this.host.settings.maxBitrate,
      Math.max(
        500_000,
        Math.round(
          this.source.width *
            this.source.height *
            fps *
            0.18 *
            this.rate.bitrateScale,
        ),
      ),
    );
    const format = {
      width: this.source.width,
      height: this.source.height,
      fps,
      bitrate,
      threads: Math.max(
        1,
        Math.min(this.host.settings.threads, Math.ceil(share / 2)),
      ),
    };
    // x11grab and H.264 run together. No raw frame crosses a JavaScript heap.
    const child = spawn(
      target.executable,
      videoEncoderArguments(target, format, {
        args: this.source.input(fps),
        reportsChanges: !this.source.restartable,
      }),
      {
        stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
        env: this.source.env,
      },
    );
    this.child = child;
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    this.host.own(
      {
        stop: () => {
          child.kill('SIGKILL');
        },
        closed,
      },
      target,
    );
    const failed = () => {
      if (this.child !== child) return;
      const lifetime = this.watchLifetime;
      if (!lifetime || lifetime.signal.aborted || !this.source.restartable) {
        this.close('App capture stopped. Retry the stream.');
        return;
      }
      this.excluded.add(videoTargetId(target));
      child.kill('SIGKILL');
      this.child = undefined;
      if (!this.excluded.has(videoTargetId(this.software))) {
        try {
          this.replaceEncoder(this.software);
        } catch {
          this.close('App encoder unavailable');
        }
        return;
      }
      // An installed FFmpeg may support x11grab when a managed build does not.
      void this.host
        .select(lifetime.signal, this.excluded)
        .then((next) => {
          if (!lifetime.signal.aborted && !this.child)
            this.replaceEncoder(next);
        })
        .catch(() => {
          if (!lifetime.signal.aborted)
            this.close('No usable app capture encoder');
        });
    };
    const packets = new AppPacketReader((data) => {
      if (this.child !== child) return;
      const key = isIdr(data);
      const frame: AppFrame = {
        data,
        key,
        width: this.source.width,
        height: this.source.height,
        timestamp: Math.round(performance.now() * 1000),
        codec: 'avc1.42E02A',
      };
      let sent = false,
        congested = false;
      for (const [listener, ready] of this.listeners) {
        if (!ready && !key) continue;
        this.listeners.set(listener, true);
        try {
          const accepted = listener.frame(frame);
          if (accepted === true) sent = true;
          if (accepted === false) congested = true;
        } catch {
          this.listeners.delete(listener);
          listener.end('Viewer interrupted');
          if (!this.listeners.size) this.close('All viewers disconnected');
        }
      }
      if (
        this.source.restartable &&
        this.child === child &&
        this.rate.observe(sent, congested, performance.now())
      )
        this.replaceEncoder(target);
    });
    const sizes = child.stdio[3];
    if (!(sizes instanceof Readable) || !child.stdout) {
      failed();
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        packets.data(chunk);
      } catch {
        failed();
      }
    });
    sizes.on('data', (chunk: Buffer) => {
      try {
        packets.metadata(chunk);
      } catch {
        failed();
      }
    });
    child.once('error', failed);
    child.once('close', failed);
  }

  close(reason: string): void {
    this.watchLifetime?.abort();
    this.watchLifetime = undefined;
    this.unregister?.();
    this.unregister = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
    const listeners = [...this.listeners.keys()];
    this.listeners.clear();
    for (const listener of listeners) listener.end(reason);
  }
}
