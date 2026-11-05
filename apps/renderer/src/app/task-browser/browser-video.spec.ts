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
});
