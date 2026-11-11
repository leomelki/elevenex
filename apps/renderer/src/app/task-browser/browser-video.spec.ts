import { afterEach, describe, expect, it, vi } from "vitest";
import { browserVideoSize, BrowserVideoDecoder } from "./browser-video";

const sps = () =>
  Uint8Array.from(atob("AAABZ0LAKtoDIE35cBagQEC0oAAAAwAgAAAHkeMGVAA="), (c) =>
    c.charCodeAt(0),
  );
afterEach(() => vi.unstubAllGlobals());
describe("Browser H.264 allocation boundary", () => {
  it("reads a real baseline SPS and rejects malformed or unnegotiated parameter sets", () => {
    expect(browserVideoSize(sps())).toEqual({ width: 800, height: 600 });
    expect(browserVideoSize(new Uint8Array([0, 0, 1, 103]))).toBeNull();
    const high = sps();
    high[4] = 100;
    expect(browserVideoSize(high)).toBeNull();
  });
  it("fails cleanly when the client has no WebCodecs rather than acknowledging a displayed frame", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    const decoder = new BrowserVideoDecoder();
    await expect(
      decoder.decode({
        epoch: "epoch",
        codec: "avc1.42E02A",
        key: true,
        timestamp: 0,
        data: sps(),
      }),
    ).rejects.toThrow("unavailable");
    decoder.destroy();
  });
  it('does not resurrect a decoder when codec support resolves after reset or destruction', async () => {
    let supported!: (result: { supported: boolean }) => void;
    const constructed = vi.fn();
    class Decoder {
      static isConfigSupported = () => new Promise(resolve => { supported = resolve; });
      constructor() { constructed(); }
    }
    vi.stubGlobal('VideoDecoder', Decoder);
    for (const dispose of [false, true]) {
      const decoder = new BrowserVideoDecoder();
      const result = decoder.decode({ epoch: 'epoch', codec: 'avc1.42E02A', key: true, timestamp: 0, data: sps() });
      if (dispose) decoder.destroy(); else decoder.reset();
      supported({ supported: true });
      await expect(result).rejects.toThrow('unavailable');
      decoder.destroy();
    }
    expect(constructed).not.toHaveBeenCalled();
  });
  it('expires a stalled codec capability check and cancels one immediately on reset', async () => {
    vi.useFakeTimers();
    const constructed = vi.fn();
    class Decoder {
      static isConfigSupported = () => new Promise(() => undefined);
      constructor() { constructed(); }
    }
    vi.stubGlobal('VideoDecoder', Decoder);
    const decoder = new BrowserVideoDecoder();
    const video = { epoch: 'epoch', codec: 'avc1.42E02A' as const, key: true, timestamp: 0, data: sps() };
    try {
      const timed = expect(decoder.decode(video)).rejects.toThrow('unavailable');
      await vi.advanceTimersByTimeAsync(2000); await timed;
      const cancelled = expect(decoder.decode(video)).rejects.toThrow('unavailable');
      decoder.reset(); await cancelled;
      expect(constructed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { decoder.destroy(); vi.useRealTimers(); }
  });
  it('closes late frames and ignores errors from a retired decoder', async () => {
    const instances: Decoder[] = [];
    class Decoder {
      static isConfigSupported = async () => ({ supported: true });
      state = 'configured';
      constructor(readonly callbacks: VideoDecoderInit) { instances.push(this); }
      configure(): void { /* Synthetic decoder, no native allocations. */ }
      decode(): void { /* Output is controlled to exercise callback races. */ }
      close(): void { this.state = 'closed'; }
    }
    vi.stubGlobal('VideoDecoder', Decoder);
    vi.stubGlobal('EncodedVideoChunk', class {});
    const decoder = new BrowserVideoDecoder();
    const video = { epoch: 'old', codec: 'avc1.42E02A' as const, key: true, timestamp: 0, data: sps() };
    const old = decoder.decode(video);
    const rejected = expect(old).rejects.toThrow('interrupted');
    await vi.waitFor(() => expect(instances).toHaveLength(1)); decoder.reset(); await rejected;
    const next = decoder.decode({ ...video, epoch: 'new' });
    await vi.waitFor(() => expect(instances).toHaveLength(2));
    const stale = { close: vi.fn() } as unknown as VideoFrame;
    instances[0]!.callbacks.output(stale);
    instances[0]!.callbacks.error(new DOMException('Retired decoder failed'));
    expect(stale.close).toHaveBeenCalledOnce();
    const fresh = { close: vi.fn() } as unknown as VideoFrame;
    instances[1]!.callbacks.output(fresh);
    expect(await next).toBe(fresh);
    fresh.close(); decoder.destroy();
  });
});
