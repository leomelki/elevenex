import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { RuntimeVideoEncoder } from './runtime-video-encoder.js';
import { managedVideoExecutable } from './runtime-video-catalog.js';
import { RuntimeVideoHost } from './runtime-video-host.js';
import { videoSettings } from './runtime-video-resources.js';
import type { RuntimeVideoCapture } from './runtime-tab.js';
import {
  RuntimeBrowserVideo,
  type RuntimeVideoPacket,
} from './runtime-video.js';

let jpeg: Buffer;
beforeAll(async () => {
  if (!ffmpegPath) throw new Error('Managed FFmpeg missing');
  const result = await promisify(execFile)(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=512x256',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 3_000_000, timeout: 5000 },
  );
  jpeg = result.stdout;
});
it('emits a static update immediately without another source image, then bounded dependent H.264 packets', async () => {
  const encoder = new RuntimeVideoEncoder(
    { executable: managedVideoExecutable(), kind: 'software' },
    { width: 512, height: 256, fps: 30, bitrate: 2_000_000, threads: 1 },
  );
  try {
    const key = await encoder.encode(jpeg);
    const delta = await encoder.encode(jpeg);
    expect(key.key).toBe(true);
    expect(delta.key).toBe(false);
    expect(delta.data.length).toBeLessThan(key.data.length);
    expect(key.data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
  } finally {
    encoder.stop();
    await encoder.closed;
  }
});
it('starts delivering video when an initially unavailable source becomes ready', async () => {
  const host = new RuntimeVideoHost(
    videoSettings({ ELEVENEX_BROWSER_VIDEO_ENCODER: 'software' }),
  );
  const packets: RuntimeVideoPacket[] = [];
  let ready = false;
  let reads = 0;
  const timer = setTimeout(() => {
    ready = true;
  }, 0);
  const video = new RuntimeBrowserVideo(
    {
      nextFrame: (after) => {
        reads++;
        return Promise.resolve(
          ready && after === 0
            ? { sequence: 1, width: 512, height: 256, jpeg }
            : null,
        );
      },
    },
    // Keep a starvation regression bounded even if the readiness timer cannot run.
    () => reads < 1000,
    (packet) => packets.push(packet),
    { host },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!packets.length) {
      if (Date.now() > deadline) throw new Error('Video startup timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(packets[0]).toMatchObject({ sequence: 1, video: { key: true } });
  } finally {
    clearTimeout(timer);
    video.stop();
    await video.done;
    await host.destroy();
  }
  expect(host.count).toBe(0);
});
it('bounds unacknowledged packets, resumes cumulatively and releases the encoder on stop', async () => {
  const packets: RuntimeVideoPacket[] = [];
  const video = new RuntimeBrowserVideo(
    {
      nextFrame: (after) =>
        Promise.resolve({ sequence: after + 1, width: 512, height: 256, jpeg }),
    },
    () => true,
    (packet) => packets.push(packet),
  );
  const deadline = Date.now() + 5000;
  const wait = async (count: number) => {
    while (packets.length < count) {
      if (Date.now() > deadline) throw new Error('Video delivery timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    await wait(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(packets).toHaveLength(3);
    expect(() => video.acknowledge(4)).toThrow();
    video.acknowledge(3);
    await wait(6);
    expect(packets[0].video.key).toBe(true);
    expect(packets[5].sequence).toBe(6);
  } finally {
    video.stop();
    await video.done;
  }
});

it('replaces the decoder epoch with a keyframe after a viewport change, without resetting delivery order', async () => {
  const packets: RuntimeVideoPacket[] = [];
  const video = new RuntimeBrowserVideo(
    {
      nextFrame: (after) =>
        Promise.resolve({
          sequence: after + 1,
          width: after < 2 ? 512 : 400,
          height: after < 2 ? 256 : 200,
          jpeg,
        }),
    },
    () => true,
    (packet) => packets.push(packet),
  );
  try {
    const deadline = Date.now() + 5000;
    while (packets.length < 3) {
      if (Date.now() > deadline) throw new Error('Video resize timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(packets[2]).toMatchObject({
      sequence: 3,
      width: 400,
      height: 200,
      video: { key: true },
    });
    expect(packets[2].video.epoch).not.toBe(packets[0].video.epoch);
  } finally {
    video.stop();
    await video.done;
  }
});

it('paces and resizes capture as well as encoding while retaining logical input coordinates', async () => {
  const host = new RuntimeVideoHost(
    videoSettings({
      ELEVENEX_BROWSER_VIDEO_ENCODER: 'software',
      ELEVENEX_BROWSER_VIDEO_MAX_WIDTH: '640',
      ELEVENEX_BROWSER_VIDEO_MAX_HEIGHT: '360',
      ELEVENEX_BROWSER_VIDEO_MAX_FPS: '15',
    }),
  );
  const requests: RuntimeVideoCapture[] = [],
    packets: RuntimeVideoPacket[] = [];
  const video = new RuntimeBrowserVideo(
    {
      nextFrame: (after, _signal, _wait, capture) => {
        if (typeof capture === 'object') requests.push(capture);
        return Promise.resolve({
          sequence: after + 1,
          width: 1024,
          height: 512,
          jpeg,
        });
      },
    },
    () => true,
    (packet) => packets.push(packet),
    { host },
  );
  try {
    const deadline = Date.now() + 5000;
    while (packets.length < 2) {
      if (Date.now() > deadline) throw new Error('Adaptive capture timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].width).toBeLessThanOrEqual(640);
    expect(requests[0].height).toBeLessThanOrEqual(360);
    expect(requests[0].fps).toBeLessThanOrEqual(15);
    expect(
      packets.every((packet) => packet.width === 1024 && packet.height === 512),
    ).toBe(true);
  } finally {
    video.stop();
    await video.done;
    await host.destroy();
  }
});

it('starts a keyframe epoch for a new document at the same viewport size', async () => {
  const packets: RuntimeVideoPacket[] = [];
  const video = new RuntimeBrowserVideo({ nextFrame: after => Promise.resolve({
    sequence: after + 1, width: 512, height: 256, jpeg, displayEpoch: after < 2 ? 1 : 2,
  }) }, () => true, packet => packets.push(packet));
  try {
    const deadline = Date.now() + 5000;
    while (packets.length < 3) {
      if (Date.now() > deadline) throw new Error('Document keyframe timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(packets[2]).toMatchObject({ sequence: 3, displayEpoch: 2, video: { key: true } });
    expect(packets[2].video.epoch).not.toBe(packets[0].video.epoch);
  } finally { video.stop(); await video.done; }
});
