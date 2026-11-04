import { describe, it, expect } from 'vitest';
import { browserFrameSize } from './browser-frame';
const header = (width: number, height: number) =>
  new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    8,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
  ]);
describe('Browser frame allocation bounds', () => {
  it('reads ordinary and progressive JPEG sizes before allocating decoded pixels', () => {
    expect(browserFrameSize(header(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
    const progressive = header(390, 600);
    progressive[3] = 194;
    expect(browserFrameSize(progressive)).toEqual({ width: 390, height: 600 });
  });
  it('rejects malformed segments, absent headers, oversized dimensions and decompression-sized allocations', () => {
    expect(browserFrameSize(new Uint8Array(12))).toBeNull();
    expect(browserFrameSize(header(65535, 65535))).toBeNull();
    expect(browserFrameSize(header(4096, 4096))).toBeNull();
    const malformed = header(10, 10);
    malformed[5] = 255;
    expect(browserFrameSize(malformed)).toBeNull();
    expect(browserFrameSize(header(0, 600))).toBeNull();
  });
});
