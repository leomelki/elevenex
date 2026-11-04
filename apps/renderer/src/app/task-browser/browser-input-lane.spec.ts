import { describe, it, expect, vi } from "vitest";
import { BrowserInputLane } from "./browser-input-lane";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const text = (value: string) => ({ kind: "text" as const, text: value });
describe("Browser human input lane", () => {
  it("retains human keystrokes across its own takeover, then drops queued text on explicit hand-back", async () => {
    const first = deferred<number>(),
      dispatch = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(2);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, "agent", true);
    lane.send(text("a"));
    lane.send(text("b"));
    lane.authority(2, "you", true);
    first.resolve(2);
    await first.promise;
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(2);
    const pending = deferred<number>();
    dispatch.mockReturnValueOnce(pending.promise);
    lane.send(text("c"));
    lane.send(text("private queued text"));
    lane.authority(3, "agent", true);
    pending.resolve(2);
    await pending.promise;
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(3);
    lane.destroy();
  });
  it("never retries an uncertain input and rejects work after visibility loss or destruction", async () => {
    const pending = deferred<number>(),
      dispatch = vi.fn(() => pending.promise),
      interrupted = vi.fn();
    const lane = new BrowserInputLane(dispatch, interrupted);
    lane.authority(4, "you", true);
    lane.send(text("one"));
    lane.send(text("two"));
    pending.reject(new Error("disconnected"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(interrupted).toHaveBeenCalledTimes(1);
    lane.authority(5, "you", false);
    lane.send(text("hidden"));
    lane.destroy();
    lane.send(text("destroyed"));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("batches ordered typing behind a slow request without batching clipboard commands", async () => {
    const pending = deferred<number>(),
      dispatch = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, "you", true);
    lane.send(text("first"));
    for (let index = 0; index < 30; index++) lane.send(text(String(index)));
    lane.send({ kind: "clipboard", operation: "copy" });
    lane.send(text("last"));
    pending.resolve(1);
    await pending.promise;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(dispatch.mock.calls[1]?.[1]).toEqual({
      kind: "batch",
      events: Array.from({ length: 30 }, (_, index) => text(String(index))),
    });
    expect(dispatch.mock.calls[2]?.[1]).toEqual({
      kind: "clipboard",
      operation: "copy",
    });
    expect(dispatch.mock.calls[3]?.[1]).toEqual(text("last"));
    lane.destroy();
  });
  it("drops queued text when an accepted event changes document generation", async () => {
    const pending = deferred<number>(),
      dispatch = vi.fn(() => pending.promise),
      interrupted = vi.fn();
    const lane = new BrowserInputLane(dispatch, interrupted);
    lane.authority(1, "you", true);
    lane.send(text("submitted"));
    lane.send(text("never type on the next page"));
    pending.resolve(3);
    await pending.promise;
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(interrupted).toHaveBeenCalledTimes(1);
    lane.destroy();
  });
  it("requires explicit interaction after uncertain delivery", async () => {
    const pending = deferred<number>(), dispatch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, 'you', true); lane.send(text('uncertain'));
    pending.reject(new Error('lost receipt')); await pending.promise.catch(() => undefined); await Promise.resolve();
    lane.authority(1, 'you', true); lane.send(text('never continue automatically'));
    expect(dispatch).toHaveBeenCalledTimes(1); expect(lane.needsInteraction).toBe(true);
    lane.resume(); lane.send(text('explicit page focus'));
    await Promise.resolve(); await Promise.resolve(); expect(dispatch).toHaveBeenCalledTimes(2);
    lane.destroy();
  });
  it("coalesces motion while preserving ordered bounded keyboard input", async () => {
    const pending = deferred<number>(),
      dispatch = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, "you", true);
    lane.send(text("first"));
    for (let i = 0; i < 100; i++)
      lane.send({
        kind: "pointer",
        type: "move",
        x: i,
        y: 2,
        button: "none",
        buttons: 0,
        clicks: 0,
        modifiers: 0,
      });
    pending.resolve(1);
    await pending.promise;
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[1]).toMatchObject({ x: 99 });
    lane.destroy();
  });
});
