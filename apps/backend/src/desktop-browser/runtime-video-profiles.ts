/** Encoder-specific options stay here; transport and adaptation never build commands. */
export type VideoEncoderKind =
  | 'videotoolbox'
  | 'nvenc'
  | 'qsv'
  | 'amf'
  | 'vaapi'
  | 'mediafoundation'
  | 'v4l2'
  | 'software';
export interface VideoEncoderTarget {
  readonly executable: string;
  readonly kind: VideoEncoderKind;
  readonly device?: string;
}
export interface VideoFormat {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  readonly threads: number;
}
export const VIDEO_ENCODERS: Readonly<Record<VideoEncoderKind, string>> = {
  videotoolbox: 'h264_videotoolbox',
  nvenc: 'h264_nvenc',
  qsv: 'h264_qsv',
  amf: 'h264_amf',
  vaapi: 'h264_vaapi',
  mediafoundation: 'h264_mf',
  v4l2: 'h264_v4l2m2m',
  software: 'libx264',
};
export function videoTargetId(target: VideoEncoderTarget): string {
  return JSON.stringify([target.executable, target.kind, target.device ?? '']);
}
export function videoEncoderArguments(
  target: VideoEncoderTarget,
  format: VideoFormat,
): string[] {
  const { width, height, fps, bitrate, threads } = format;
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  // Use the lowest sufficient level, allowing older hardware to serve smaller
  // views. The negotiated decoder ceiling remains baseline level 4.2.
  const level = [
    { id: 31, frame: 3600, second: 108000, rate: 14_000_000 },
    { id: 32, frame: 5120, second: 216000, rate: 20_000_000 },
    { id: 40, frame: 8192, second: 245760, rate: 20_000_000 },
    { id: 42, frame: 8704, second: 522240, rate: 50_000_000 },
  ].find(
    (limit) =>
      macroblocks <= limit.frame &&
      macroblocks * fps <= limit.second &&
      bitrate <= limit.rate,
  );
  if (
    ![width, height, fps, bitrate, threads].every(Number.isSafeInteger) ||
    width < 16 ||
    height < 16 ||
    width > 1920 ||
    height > 1440 ||
    width % 2 ||
    height % 2 ||
    fps < 1 ||
    fps > 60 ||
    bitrate < 250_000 ||
    bitrate > 16_000_000 ||
    threads < 1 ||
    threads > 4 ||
    !level ||
    (target.device &&
      !/^(?:[0-9]|\/dev\/dri\/renderD[0-9]{3,5})$/.test(target.device))
  )
    throw new Error('Invalid video encoder configuration');
  const scale = `scale=${width}:${height}`;
  const device = target.device;
  const setup =
    target.kind === 'vaapi' && device
      ? ['-vaapi_device', device]
      : target.kind === 'qsv'
        ? [
            '-init_hw_device',
            `qsv=browser:hw_any${device ? `,child_device=${device}${/^[0-9]$/.test(device) ? ',child_device_type=d3d11va' : ''}` : ''}`,
          ]
        : [];
  const filter =
    target.kind === 'vaapi' ? `${scale},format=nv12,hwupload` : scale;
  const options: Readonly<Record<VideoEncoderKind, readonly string[]>> = {
    videotoolbox: ['-realtime', '1', '-allow_sw', '0'],
    nvenc: [
      '-preset',
      'p1',
      '-tune',
      'ull',
      '-zerolatency',
      '1',
      '-rc',
      'cbr',
      '-rc-lookahead',
      '0',
      '-delay',
      '0',
      ...(device ? ['-gpu', device] : []),
    ],
    qsv: ['-preset', 'veryfast', '-async_depth', '1', '-look_ahead', '0'],
    amf: [
      '-usage',
      'ultralowlatency',
      '-quality',
      'speed',
      '-rc',
      'cbr',
      '-preanalysis',
      '0',
    ],
    vaapi: ['-async_depth', '1', '-rc_mode', 'CBR'],
    mediafoundation: [
      '-hw_encoding',
      '1',
      '-scenario',
      'display_remoting',
      '-rate_control',
      'cbr',
    ],
    v4l2: ['-num_output_buffers', '4', '-num_capture_buffers', '4'],
    software: ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18'],
  };
  const profile =
    target.kind === 'amf' || target.kind === 'vaapi'
      ? 'constrained_baseline'
      : 'baseline';
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-filter_threads',
    '1',
    ...setup,
    // Explicit lengths avoid waiting for another JPEG to delimit a static update.
    '-f',
    'mpjpeg',
    '-r',
    String(fps),
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-threads',
    '1',
    '-i',
    'pipe:0',
    '-an',
    '-threads',
    String(threads),
    '-vf',
    filter,
    ...(target.kind === 'vaapi'
      ? []
      : [
          '-pix_fmt',
          target.kind === 'software' || target.kind === 'v4l2'
            ? 'yuv420p'
            : 'nv12',
        ]),
    '-c:v',
    VIDEO_ENCODERS[target.kind],
    ...options[target.kind],
    '-profile:v',
    profile,
    '-level:v',
    String(level.id),
    '-bf',
    '0',
    '-refs',
    '1',
    '-g',
    String(fps * 2),
    '-b:v',
    String(bitrate),
    '-maxrate',
    String(bitrate),
    '-bufsize',
    // At least two frame budgets: a fixed 1/15-second buffer forces blocky
    // keyframes when capture or network feedback reduces the frame rate.
    String(Math.round(Math.max(bitrate / 2, (bitrate * 2) / fps))),
    // Packet framing uses a private sideband, never a buffered video container.
    '-stats_mux_pre',
    'pipe:3',
    '-stats_mux_pre_fmt',
    '{size}',
    '-flush_packets',
    '1',
    '-f',
    'h264',
    'pipe:1',
  ];
}
