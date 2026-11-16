import { availableParallelism, cpus, freemem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  VIDEO_ENCODERS,
  type VideoEncoderKind,
} from './runtime-video-profiles.js';

export interface VideoSettings {
  readonly encoder: VideoEncoderKind | 'auto';
  readonly executable?: string;
  readonly device?: string;
  readonly maxFps: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxBitrate: number;
  readonly threads: number;
}
function isVideoEncoder(value: string): value is VideoEncoderKind | 'auto' {
  return value === 'auto' || Object.hasOwn(VIDEO_ENCODERS, value);
}
export function videoSettings(
  environment: NodeJS.ProcessEnv = process.env,
): VideoSettings {
  const integer = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const value = environment[`ELEVENEX_BROWSER_VIDEO_${key}`];
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value) || Number(value) < min || Number(value) > max)
      throw new Error(`Invalid browser video ${key}`);
    return Number(value);
  };
  const encoder = environment['ELEVENEX_BROWSER_VIDEO_ENCODER'] ?? 'auto';
  if (!isVideoEncoder(encoder))
    throw new Error('Invalid browser video encoder');
  const executable = environment['ELEVENEX_BROWSER_FFMPEG'];
  if (executable && (!isAbsolute(executable) || executable.length > 4096))
    throw new Error('Browser FFmpeg must be an absolute executable path');
  const device = environment['ELEVENEX_BROWSER_VIDEO_DEVICE'];
  if (device && !/^(?:[0-9]|\/dev\/dri\/renderD[0-9]{3,5})$/.test(device))
    throw new Error('Invalid browser video device');
  return {
    encoder,
    executable,
    device,
    maxFps: integer('MAX_FPS', 60, 5, 60),
    maxWidth: integer('MAX_WIDTH', 1920, 640, 1920),
    maxHeight: integer('MAX_HEIGHT', 1440, 360, 1440),
    maxBitrate: integer('MAX_BITRATE', 8_000_000, 250_000, 16_000_000),
    threads: integer('CPU_THREADS', Math.min(2, availableParallelism()), 1, 4),
  };
}
export interface VideoResources {
  readonly cores: number;
  readonly memory: number;
  readonly busy: number;
}
function cpuTime(): { idle: number; total: number } {
  let idle = 0,
    total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}
/** Sample only while a presentation asks, at most once a second. No background timer. */
export class RuntimeVideoResources {
  private previous = cpuTime();
  private checked = 0;
  private quota = availableParallelism();
  private memoryLimit = Infinity;
  private value: VideoResources = {
    cores: this.quota,
    memory: freemem(),
    busy: 0,
  };
  private readonly initialized: Promise<void>;
  constructor() {
    this.initialized = this.readLimits();
  }
  private async readLimits(): Promise<void> {
    if (process.platform !== 'linux') return;
    // cgroup v2 and v1, including hosts without a mounted controller. These tiny
    // kernel files supplement affinity; availableParallelism alone misses quotas.
    const read = async (file: string) =>
      (await readFile(file, 'utf8').catch(() => '')).slice(0, 128).trim();
    const [cpu, oldQuota, period, memory, oldMemory] = await Promise.all([
      read('/sys/fs/cgroup/cpu.max'),
      read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
      read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
      read('/sys/fs/cgroup/memory.max'),
      read('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    ]);
    const pair = cpu.split(/\s+/),
      numerator = Number(pair[0]) || Number(oldQuota),
      denominator = Number(pair[1]) || Number(period);
    if (numerator > 0 && denominator > 0)
      this.quota = Math.min(this.quota, numerator / denominator);
    const limit = Number(memory) || Number(oldMemory);
    if (limit > 0) this.memoryLimit = limit;
  }
  async ready(): Promise<void> {
    await this.initialized;
  }
  snapshot(now = performance.now()): VideoResources {
    if (now - this.checked < 1000 && this.checked !== 0) return this.value;
    const next = cpuTime(),
      elapsed = next.total - this.previous.total;
    const busy =
      elapsed > 0
        ? 1 - (next.idle - this.previous.idle) / elapsed
        : this.value.busy;
    this.previous = next;
    this.checked = now;
    const available =
      typeof process.availableMemory === 'function'
        ? process.availableMemory()
        : freemem();
    this.value = {
      cores: this.quota,
      memory: Math.min(available, freemem(), this.memoryLimit),
      busy: Math.max(0, Math.min(1, busy)),
    };
    return this.value;
  }
}
