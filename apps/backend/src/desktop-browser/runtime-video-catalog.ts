import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import {
  RuntimeVideoEncoder,
  videoProcessEnvironment,
} from './runtime-video-encoder.js';
import {
  VIDEO_ENCODERS,
  videoTargetId,
  type VideoEncoderKind,
  type VideoEncoderTarget,
} from './runtime-video-profiles.js';
import type { VideoSettings } from './runtime-video-resources.js';

export function managedVideoExecutable(): string {
  return join(
    dirname(createRequire(__filename).resolve('ffmpeg-static/package.json')),
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );
}
export function videoCandidates(
  executable: string,
  compiled: ReadonlySet<string>,
  platform: NodeJS.Platform,
  devices: readonly string[],
  settings: VideoSettings,
): VideoEncoderTarget[] {
  const kinds: readonly VideoEncoderKind[] =
    platform === 'darwin'
      ? ['videotoolbox']
      : platform === 'win32'
        ? ['nvenc', 'qsv', 'amf', 'mediafoundation']
        : platform === 'linux'
          ? ['nvenc', 'qsv', 'vaapi', 'v4l2']
          : [];
  const targets: VideoEncoderTarget[] = [];
  for (const kind of [...kinds, 'software' as const]) {
    if (
      !compiled.has(VIDEO_ENCODERS[kind]) ||
      (settings.encoder !== 'auto' &&
        kind !== settings.encoder &&
        kind !== 'software')
    )
      continue;
    const candidates =
      kind === 'vaapi' || (kind === 'qsv' && platform === 'linux')
        ? settings.device?.startsWith('/dev/dri/renderD')
          ? [settings.device]
          : devices.slice(0, 4)
        : kind === 'nvenc'
          ? settings.device && /^[0-9]$/.test(settings.device)
            ? [settings.device]
            : ['0', '1', '2', '3']
          : kind === 'qsv' &&
              platform === 'win32' &&
              settings.device &&
              /^[0-9]$/.test(settings.device)
            ? [settings.device]
            : [undefined];
    for (const device of candidates) {
      if (settings.device && kind !== 'software' && device !== settings.device)
        continue;
      targets.push({ executable, kind, ...(device ? { device } : {}) });
    }
  }
  return targets;
}

// Page-free, locally generated 160x96 gray JPEG. No captured pixels are used in
// capability probing, cached, persisted or passed to diagnostics.
const PROBE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYwLjMuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEoAAQAAAAAAAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCABgAKADASIAAhEAAxEA/9oADAMBAAIRAxEAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2Q==',
  'base64',
);

/** Application-owned, coalesced capability discovery. A compiled codec is not a working device. */
export class RuntimeVideoCatalog {
  private readonly lifetime = new AbortController();
  private discovery?: Promise<readonly VideoEncoderTarget[]>;
  private readonly probes = new Map<string, Promise<boolean>>();
  private readonly results = new Map<
    string,
    { valid: boolean; until: number }
  >();
  private readonly encoders = new Set<RuntimeVideoEncoder>();
  constructor(
    readonly settings: VideoSettings,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}
  targets(): Promise<readonly VideoEncoderTarget[]> {
    this.discovery ??= this.discover();
    return this.discovery;
  }
  private async discover(): Promise<readonly VideoEncoderTarget[]> {
    const binaries: string[] = [];
    const candidatePaths = [
      this.settings.executable,
      managedVideoExecutable(),
      ...(this.environment['PATH'] ?? '')
        .split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .slice(0, 32)
        .map((directory) =>
          join(
            directory,
            process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
          ),
        ),
    ];
    for (const file of candidatePaths) {
      if (!file || binaries.length >= 3) continue;
      try {
        await access(file, constants.X_OK);
        const actual = await realpath(file);
        if ((await stat(actual)).isFile() && !binaries.includes(actual))
          binaries.push(actual);
      } catch {
        /* A host FFmpeg installation is optional. */
      }
    }
    const devices =
      process.platform === 'linux'
        ? (await readdir('/dev/dri').catch(() => []))
            .filter((name) => /^renderD[0-9]{3,5}$/.test(name))
            .sort()
            .slice(0, 4)
            .map((name) => `/dev/dri/${name}`)
        : [];
    const targets: VideoEncoderTarget[] = [];
    for (const executable of binaries) {
      this.lifetime.signal.throwIfAborted();
      try {
        const { stdout } = await promisify(execFile)(
          executable,
          ['-hide_banner', '-encoders'],
          {
            timeout: 2000,
            maxBuffer: 256 * 1024,
            windowsHide: true,
            signal: this.lifetime.signal,
            env: videoProcessEnvironment(),
          },
        );
        const compiled = new Set(
          [...stdout.matchAll(/^\s*V\S{5}\s+([a-z0-9_]+)/gm)].map(
            (match) => match[1],
          ),
        );
        targets.push(
          ...videoCandidates(
            executable,
            compiled,
            process.platform,
            devices,
            this.settings,
          ),
        );
      } catch {
        /* Missing libraries or an incompatible host binary cannot disable the managed fallback. */
      }
    }
    // Favor hardware across all binaries, then the known managed software build.
    return targets.sort(
      (a, b) => Number(a.kind === 'software') - Number(b.kind === 'software'),
    );
  }
  reject(target: VideoEncoderTarget): void {
    this.results.set(videoTargetId(target), {
      valid: false,
      until: performance.now() + 30_000,
    });
  }
  async usable(target: VideoEncoderTarget): Promise<boolean> {
    const id = videoTargetId(target),
      cached = this.results.get(id);
    if (cached && cached.until > performance.now()) return cached.valid;
    const existing = this.probes.get(id);
    if (existing) return existing;
    const checking = this.probe(target)
      .then((valid) => {
        this.results.set(id, {
          valid,
          until: performance.now() + (valid ? 300_000 : 30_000),
        });
        return valid;
      })
      .finally(() => this.probes.delete(id));
    this.probes.set(id, checking);
    return checking;
  }
  private async probe(target: VideoEncoderTarget): Promise<boolean> {
    if (this.lifetime.signal.aborted) return false;
    const encoder = new RuntimeVideoEncoder(target, {
      width: 256,
      height: 256,
      fps: 30,
      bitrate: 1_000_000,
      threads: 1,
    });
    this.encoders.add(encoder);
    try {
      const frame = await encoder.encode(PROBE_JPEG, 1000);
      // An IDR and baseline SPS must arrive without submitting a future image.
      // Hardware that buffers or silently changes profile is not this protocol.
      let baseline = false;
      for (let i = 0; i + 5 < frame.data.length; i++)
        if (
          frame.data[i] === 0 &&
          frame.data[i + 1] === 0 &&
          frame.data[i + 2] === 1 &&
          (frame.data[i + 3] & 31) === 7 &&
          frame.data[i + 4] === 66
        )
          baseline = true;
      return (
        frame.key &&
        baseline &&
        (await this.decodable(target.executable, frame.data))
      );
    } catch {
      return false;
    } finally {
      encoder.stop();
      await encoder.closed;
      this.encoders.delete(encoder);
    }
  }
  private decodable(executable: string, data: Buffer): Promise<boolean> {
    return new Promise((resolve) => {
      // Validate an independently decodable access unit, not just an encoder
      // name or SPS-looking bytes. This uses only the synthetic probe image.
      const child = execFile(
        executable,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-xerror',
          '-threads',
          '1',
          '-f',
          'h264',
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-vf',
          'scale=16:16',
          '-pix_fmt',
          'rgb24',
          '-threads',
          '1',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        {
          timeout: 1000,
          maxBuffer: 4096,
          encoding: 'buffer',
          windowsHide: true,
          signal: this.lifetime.signal,
          env: videoProcessEnvironment(),
        },
        (error, stdout) => resolve(!error && stdout.length === 16 * 16 * 3),
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(data);
    });
  }
  async destroy(): Promise<void> {
    this.lifetime.abort();
    for (const encoder of this.encoders) encoder.stop();
    await Promise.allSettled([
      ...this.probes.values(),
      ...(this.discovery ? [this.discovery] : []),
    ]);
    this.results.clear();
  }
}
