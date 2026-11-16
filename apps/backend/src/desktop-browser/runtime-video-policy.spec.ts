import { RuntimeVideoHost } from './runtime-video-host.js';
import { RuntimeVideoQuality } from './runtime-video-quality.js';
import { videoSettings } from './runtime-video-resources.js';
import {
  videoCandidates,
  RuntimeVideoCatalog,
  managedVideoExecutable,
} from './runtime-video-catalog.js';
import {
  RuntimeVideoEncoder,
  videoProcessEnvironment,
} from './runtime-video-encoder.js';
import {
  VIDEO_ENCODERS,
  videoEncoderArguments,
  type VideoEncoderTarget,
} from './runtime-video-profiles.js';

const settings = videoSettings({});
const plenty = { cores: 16, memory: 8 * 1024 ** 3, busy: 0.1 };
const viewport = { width: 1920, height: 1080, pixelRatio: 1 };

describe('hardware selection and device confinement', () => {
  const compiled = new Set(Object.values(VIDEO_ENCODERS));
  it('offers platform backends only when compiled, with bounded multi-GPU discovery and software fallback', () => {
    const linux = videoCandidates(
      '/ffmpeg',
      compiled,
      'linux',
      ['/dev/dri/renderD128', '/dev/dri/renderD129'],
      settings,
    );
    expect(linux.filter((target) => target.kind === 'nvenc')).toHaveLength(4);
    expect(linux.filter((target) => target.kind === 'vaapi')).toHaveLength(2);
    expect(linux.filter((target) => target.kind === 'qsv')).toHaveLength(2);
    expect(linux.at(-1)?.kind).toBe('software');
    const windows = videoCandidates(
      'C:\\ffmpeg.exe',
      compiled,
      'win32',
      [],
      settings,
    );
    expect(windows.map((target) => target.kind)).toEqual(
      expect.arrayContaining([
        'nvenc',
        'qsv',
        'amf',
        'mediafoundation',
        'software',
      ]),
    );
    expect(windows.some((target) => target.kind === 'vaapi')).toBe(false);
    expect(
      videoCandidates('/ffmpeg', new Set(['libx264']), 'linux', [], settings),
    ).toEqual([{ executable: '/ffmpeg', kind: 'software' }]);
  });
  it('honors an explicit available device and software-only configuration without accepting command fragments', () => {
    const selected = videoSettings({
      ELEVENEX_BROWSER_VIDEO_ENCODER: 'nvenc',
      ELEVENEX_BROWSER_VIDEO_DEVICE: '7',
    });
    expect(videoCandidates('/ffmpeg', compiled, 'linux', [], selected)).toEqual(
      [
        { executable: '/ffmpeg', kind: 'nvenc', device: '7' },
        { executable: '/ffmpeg', kind: 'software' },
      ],
    );
    expect(
      videoCandidates(
        '/ffmpeg',
        compiled,
        'linux',
        [],
        videoSettings({ ELEVENEX_BROWSER_VIDEO_ENCODER: 'software' }),
      ),
    ).toEqual([{ executable: '/ffmpeg', kind: 'software' }]);
    for (const environment of [
      { ELEVENEX_BROWSER_VIDEO_DEVICE: '/tmp/device' },
      { ELEVENEX_BROWSER_VIDEO_DEVICE: '0;command' },
      { ELEVENEX_BROWSER_FFMPEG: 'relative-ffmpeg' },
      { ELEVENEX_BROWSER_VIDEO_MAX_FPS: '120' },
      { ELEVENEX_BROWSER_VIDEO_ENCODER: 'unknown' },
    ])
      expect(() => videoSettings(environment)).toThrow();
  });
  it('uses explicit upload and low-latency options and confines device paths before process execution', () => {
    const format = {
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4_000_000,
      threads: 2,
    };
    const vaapi = videoEncoderArguments(
      { executable: '/ffmpeg', kind: 'vaapi', device: '/dev/dri/renderD128' },
      format,
    );
    expect(vaapi).toContain('scale=1280:720,format=nv12,hwupload');
    const nvenc = videoEncoderArguments(
      { executable: '/ffmpeg', kind: 'nvenc', device: '1' },
      format,
    );
    expect(nvenc).toContain('ull');
    expect(nvenc).toContain('pipe:3');
    expect(
      videoEncoderArguments({ executable: '/ffmpeg', kind: 'qsv' }, format),
    ).toContain('qsv=browser:hw_any');
    expect(() =>
      videoEncoderArguments(
        { executable: '/ffmpeg', kind: 'vaapi', device: '/etc/passwd' },
        format,
      ),
    ).toThrow();
    expect(() =>
      videoEncoderArguments(
        { executable: '/ffmpeg', kind: 'software' },
        { ...format, width: 4096 },
      ),
    ).toThrow();
  });
});

describe('adaptive interactive video', () => {
  it('preserves text resolution on CPU servers, including tall retina panels and slow steady links', () => {
    const landscape = new RuntimeVideoQuality(settings).select(viewport, false, plenty, 1);
    expect(landscape.width).toBe(1920);
    expect(landscape.height).toBe(1080);
    const quality = new RuntimeVideoQuality(settings);
    quality.acknowledged(500);
    const tall = quality.select({ width: 440, height: 1400, pixelRatio: 2 }, false, plenty, 1);
    expect(tall.width).toBeGreaterThanOrEqual(440);
    expect(tall.height).toBeGreaterThanOrEqual(1438);
    expect(tall.height).toBeLessThanOrEqual(1440);
    expect(tall.bitrate).toBeGreaterThanOrEqual(2_000_000);
    const args = videoEncoderArguments({ executable: '/ffmpeg', kind: 'software' }, tall);
    expect(Number(args[args.indexOf('-bufsize') + 1])).toBeGreaterThanOrEqual(tall.bitrate / 2);
    for (let n = 0; n < 30; n++) quality.encoded(250);
    const sparse = quality.select({ width: 440, height: 1400, pixelRatio: 2 }, false, plenty, 1);
    expect(sparse.fps).toBe(2);
    expect(sparse.bitrate).toBeGreaterThanOrEqual(2_000_000);
    const slowArgs = videoEncoderArguments({ executable: '/ffmpeg', kind: 'software' }, sparse);
    expect(Number(slowArgs[slowArgs.indexOf('-bufsize') + 1])).toBeGreaterThanOrEqual(sparse.bitrate);
  });
  it('uses hardware capacity while sharing software and memory budgets across presentations', () => {
    const high = new RuntimeVideoQuality(settings).select(
      viewport,
      true,
      plenty,
      1,
      0,
    );
    const limited = new RuntimeVideoQuality(settings).select(
      viewport,
      false,
      { cores: 0.5, memory: 256 * 1024 ** 2, busy: 0.95 },
      4,
      0,
    );
    expect(high.fps).toBe(60);
    expect(high.width).toBe(1920);
    expect(limited.width * limited.height * limited.fps).toBeLessThan(
      high.width * high.height * high.fps,
    );
    expect(limited.fps).toBeGreaterThanOrEqual(8);
    expect(limited.threads).toBe(1);
    const shared = new RuntimeVideoQuality(settings).select(
      viewport,
      false,
      plenty,
      16,
      0,
    );
    const single = new RuntimeVideoQuality(settings).select(
      viewport,
      false,
      plenty,
      1,
      0,
    );
    expect(shared.width * shared.height * shared.fps).toBeLessThan(
      single.width * single.height * single.fps,
    );
  });
  it('reacts to slow encoding and display queuing while distinguishing steady RTT from congestion', () => {
    const healthy = new RuntimeVideoQuality(settings),
      slow = new RuntimeVideoQuality(settings);
    for (let n = 0; n < 20; n++) slow.encoded(100);
    expect(slow.select(viewport, true, plenty, 1, 0).fps).toBeLessThan(
      healthy.select(viewport, true, plenty, 1, 0).fps,
    );
    healthy.acknowledged(200, 0);
    expect(healthy.window(8, 30)).toBe(7);
    expect(healthy.window(3, 30)).toBe(3);
    const before = healthy.select(viewport, true, plenty, 1, 0);
    expect(before.fps).toBeLessThan(settings.maxFps);
    for (let n = 0; n < 6; n++) healthy.acknowledged(500, 3000 + n * 1000);
    expect(healthy.select(viewport, true, plenty, 1, 9000).fps).toBeLessThan(
      before.fps,
    );
    const steady = new RuntimeVideoQuality(settings);
    steady.acknowledged(500, 0);
    const steadyRate = steady.select(viewport, true, plenty, 1, 0).fps;
    for (let n = 1; n < 10; n++) steady.acknowledged(500, n * 1000);
    expect(steady.select(viewport, true, plenty, 1, 10000).fps).toBe(
      steadyRate,
    );
  });
  it('reduces resolution promptly, recovers slowly, and preserves aspect after a real viewport change', () => {
    const policy = new RuntimeVideoQuality(settings);
    const reduced = policy.select(
      viewport,
      true,
      { ...plenty, memory: 8 * 1024 ** 2 },
      1,
      0,
    );
    expect(policy.select(viewport, true, plenty, 1, 1000).width).toBe(
      reduced.width,
    );
    expect(
      policy.select(viewport, true, plenty, 1, 12000).width,
    ).toBeGreaterThan(reduced.width);
    const phone = policy.select(
      { width: 390, height: 800 },
      true,
      plenty,
      1,
      13000,
    );
    expect(Math.abs(phone.width / phone.height - 390 / 800)).toBeLessThan(0.02);
    const tall = policy.select(
      { width: 1920, height: 1440, pixelRatio: 2 },
      true,
      plenty,
      1,
      14000,
    );
    expect(
      Math.ceil(tall.width / 16) * Math.ceil(tall.height / 16) * tall.fps,
    ).toBeLessThanOrEqual(522240);
    expect(
      Math.ceil(tall.width / 16) * Math.ceil(tall.height / 16),
    ).toBeLessThanOrEqual(8704);
  });
});

it('cancels queued CPU work, serializes constrained hosts, and refuses work after shutdown', async () => {
  const host = new RuntimeVideoHost(
    videoSettings({ ELEVENEX_BROWSER_VIDEO_ENCODER: 'software' }),
  );
  jest
    .spyOn(host.resources, 'snapshot')
    .mockReturnValue({ cores: 1, memory: 512 * 1024 ** 2, busy: 0 });
  let release: (() => void) | undefined;
  const encoder = {
    encode: jest.fn(
      () =>
        new Promise<{ data: Buffer; key: boolean }>((resolve) => {
          release = () => resolve({ data: Buffer.from([1]), key: true });
        }),
    ),
  };
  const controller = new AbortController();
  try {
    const first = host.encode(
      encoder,
      Buffer.from([1]),
      new AbortController().signal,
    );
    const second = host.encode(encoder, Buffer.from([2]), controller.signal);
    const cancelled = expect(second).rejects.toThrow('interrupted');
    expect(encoder.encode).toHaveBeenCalledTimes(1);
    controller.abort();
    await cancelled;
    release?.();
    await first;
    expect(encoder.encode).toHaveBeenCalledTimes(1);
    await host.destroy();
    await expect(
      host.encode(encoder, Buffer.from([3]), new AbortController().signal),
    ).rejects.toThrow('capacity');
  } finally {
    release?.();
    await host.destroy();
  }
});

it('selects the next usable target when a compiled hardware encoder cannot produce output', async () => {
  const host = new RuntimeVideoHost();
  const targets: VideoEncoderTarget[] = [
    { executable: '/gpu', kind: 'nvenc' },
    { executable: '/cpu', kind: 'software' },
  ];
  jest.spyOn(host.catalog, 'targets').mockResolvedValue(targets);
  const usable = jest
    .spyOn(host.catalog, 'usable')
    .mockImplementation((target) =>
      Promise.resolve(target.kind === 'software'),
    );
  try {
    expect(
      (await host.select(new AbortController().signal, new Set())).kind,
    ).toBe('software');
    expect(usable).toHaveBeenCalledTimes(2);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(host.select(cancelled.signal, new Set())).rejects.toThrow();
  } finally {
    await host.destroy();
  }
});

it('coalesces and caches real encode/decode probes without admitting diagnostic file output', async () => {
  const catalog = new RuntimeVideoCatalog(settings, { PATH: '' });
  const target: VideoEncoderTarget = {
    executable: managedVideoExecutable(),
    kind: 'software',
  };
  const encode = jest.spyOn(RuntimeVideoEncoder.prototype, 'encode');
  const old = process.env['FFREPORT'];
  process.env['FFREPORT'] = 'file=private-diagnostics.log';
  try {
    expect(videoProcessEnvironment()['FFREPORT']).toBeUndefined();
    expect(
      await Promise.all([catalog.usable(target), catalog.usable(target)]),
    ).toEqual([true, true]);
    expect(await catalog.usable(target)).toBe(true);
    expect(encode).toHaveBeenCalledTimes(1);
    catalog.reject(target);
    expect(await catalog.usable(target)).toBe(false);
  } finally {
    if (old === undefined) delete process.env['FFREPORT'];
    else process.env['FFREPORT'] = old;
    encode.mockRestore();
    await catalog.destroy();
  }
});
