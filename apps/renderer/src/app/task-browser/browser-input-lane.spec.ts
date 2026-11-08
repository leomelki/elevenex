import { describe, it, expect, vi } from "vitest";
import { BrowserInputLane } from "./browser-input-lane";
import type { TaskBrowserStreamInput } from '@elevenex/shared';
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
const settle = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
describe("Browser human input lane", () => {
  it('reserves an immediate bounded unlock request while all movement receipts are stalled', async () => {
    const receipts = Array.from({ length: 4 }, () => deferred<number>());
    const dispatch = vi.fn<(generation: number, input: TaskBrowserStreamInput) => Promise<number>>();
    for (const receipt of receipts) dispatch.mockReturnValueOnce(receipt.promise);
    dispatch.mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn(), () => 4);
    const move = { kind: 'pointer-relative' as const, deltaX: 2, deltaY: -1, buttons: 0, modifiers: 0, pointerLockEpoch: 7 };
    lane.authority(1, 'you', true);
    for (let i = 0; i < 4; i++) { lane.send(move); await settle(); }
    lane.send(move); lane.send(text('keep typing'));
    lane.send({ kind: 'pointer-unlock', pointerLockEpoch: 7 }); await settle();
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(dispatch.mock.lastCall?.[1]).toEqual({ kind: 'pointer-unlock', pointerLockEpoch: 7 });
    for (const receipt of receipts) receipt.resolve(1);
    await settle();
    expect(dispatch.mock.calls.slice(5).map(call => call[1])).toEqual([text('keep typing')]); lane.destroy();
  });
  it('sums relative deltas only within the same lock, buttons and modifiers', async () => {
    const pending = deferred<number>(), dispatch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, 'you', true); lane.send(text('block'));
    const move = { kind: 'pointer-relative' as const, deltaX: 2, deltaY: -1, buttons: 0, modifiers: 0, pointerLockEpoch: 7 };
    lane.send(move); lane.send(move); lane.send({ ...move, pointerLockEpoch: 9 }); lane.send({ ...move, pointerLockEpoch: 9, modifiers: 8 });
    pending.resolve(1); await settle();
    expect(dispatch.mock.calls[1]?.[1]).toEqual({ kind: 'batch', events: [
      { ...move, deltaX: 4, deltaY: -2 }, { ...move, pointerLockEpoch: 9 }, { ...move, pointerLockEpoch: 9, modifiers: 8 },
    ] }); lane.destroy();
  });
  it('ignores late motion failures from a released lease without interrupting fresh input', async () => {
    const old = deferred<number>(), interrupted = vi.fn();
    const dispatch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, interrupted, () => 4);
    const move = { kind: 'pointer-relative' as const, deltaX: 2, deltaY: -1, buttons: 0, modifiers: 0, pointerLockEpoch: 7 };
    lane.authority(1, 'you', true, 7); lane.send(move); await settle();
    lane.send({ kind: 'pointer-unlock', pointerLockEpoch: 7 }); await settle();
    lane.authority(1, 'you', true, 9); lane.send({ ...move, pointerLockEpoch: 9 }); await settle();
    old.reject(new Error('Old lease ended')); await settle();
    expect(interrupted).not.toHaveBeenCalled(); expect(lane.needsInteraction).toBe(false);
    lane.send(text('fresh typing')); await settle();
    expect(dispatch.mock.lastCall?.[1]).toEqual(text('fresh typing')); lane.destroy();
  });
  it('preserves known queued typing when the user focuses an already healthy page', async () => {
    const pending = deferred<number>(), dispatch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    try {
      lane.authority(1, 'you', true); lane.send(text('a')); lane.send(text('b'));
      lane.resume(); pending.resolve(1); await settle();
      expect(dispatch.mock.calls.map(call => call[1])).toEqual([text('a'), text('b')]);
    } finally { lane.destroy(); }
  });
  it('preserves fast sustained typing through a twelve-second receipt stall', async () => {
    vi.useFakeTimers();
    const delivered: TaskBrowserStreamInput[] = [], interrupted = vi.fn();
    const began = Date.now();
    let requests = 0, active = 0, peak = 0;
    const dispatch = vi.fn((generation: number, input: TaskBrowserStreamInput) => {
      delivered.push(input);
      active++; peak = Math.max(peak, active);
      const delay = ++requests <= 4 ? Math.max(1, 12000 - (Date.now() - began)) : [80, 240, 30, 140][requests % 4]!;
      return new Promise<number>(resolve => setTimeout(() => { active--; resolve(generation); }, delay));
    });
    const lane = new BrowserInputLane(dispatch, interrupted, () => 4);
    const expected = Array.from({ length: 240 }, (_, n) => String.fromCharCode(97 + n % 26)).join('');
    try {
      lane.authority(1, 'you', true);
      for (const character of expected) {
        lane.send({ kind: 'key', type: 'down', key: character, code: 'Key' + character.toUpperCase(), keyCode: character.toUpperCase().charCodeAt(0), modifiers: 0, text: character });
        lane.send({ kind: 'key', type: 'up', key: character, code: 'Key' + character.toUpperCase(), keyCode: character.toUpperCase().charCodeAt(0), modifiers: 0 });
        await vi.advanceTimersByTimeAsync(50);
      }
      await vi.advanceTimersByTimeAsync(1000);
      const events = delivered.flatMap(input => input.kind === 'batch' ? input.events : [input]);
      expect(events.flatMap(event => event.kind === 'key' && event.type === 'down' ? [event.text ?? ''] : []).join('')).toBe(expected);
      expect(events).toHaveLength(expected.length * 2);
      expect(peak).toBe(4); expect(active).toBe(0);
      expect(interrupted).not.toHaveBeenCalled();
    } finally { lane.destroy(); vi.useRealTimers(); }
  });
  it('releases held human state on queue pressure while stopping uncertain typing', async () => {
    const pending = deferred<number>(), dispatch = vi.fn(() => pending.promise), release = vi.fn().mockResolvedValue(undefined);
    const lane = new BrowserInputLane(dispatch, vi.fn(), () => 4, release);
    lane.authority(7, 'you', true);
    lane.send({ kind: 'key', type: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: 8 });
    await settle();
    for (let n = 0; n < 513; n++) lane.send(text(String(n)));
    await settle();
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
    expect(lane.needsInteraction).toBe(true);
    pending.resolve(7); await settle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(lane.needsInteraction).toBe(true);
    lane.destroy();
  });
  it('bounds queued text memory and reclaims the budget after delivery or interruption', async () => {
    const pending = deferred<number>(), dispatch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(1), interrupted = vi.fn();
    const lane = new BrowserInputLane(dispatch, interrupted);
    try {
      lane.authority(1, 'you', true); lane.send(text('blocking'));
      lane.send(text('a'.repeat(40000))); lane.send(text('b'.repeat(25000)));
      pending.resolve(1); await settle();
      lane.send(text('c'.repeat(65536))); await settle();
      expect(interrupted).not.toHaveBeenCalled();
      const held = deferred<number>(); dispatch.mockReturnValueOnce(held.promise);
      lane.send(text('blocking again')); lane.send(text('x'.repeat(40000))); lane.send(text('y'.repeat(40000)));
      expect(interrupted).toHaveBeenCalledTimes(1);
      held.resolve(1); await settle(); lane.resume();
      lane.send(text('z'.repeat(65536))); await settle();
      expect(dispatch.mock.lastCall?.[1]).toEqual(text('z'.repeat(65536)));
      expect(interrupted).toHaveBeenCalledTimes(1);
    } finally { lane.destroy(); }
  });
  it('pipelines a bounded negotiated window through delayed receipts and preserves clipboard barriers', async () => {
    const pending = Array.from({ length: 6 }, () => deferred<number>());
    let next = 0;
    const dispatch = vi.fn<(generation: number, input: TaskBrowserStreamInput) => Promise<number>>(() => pending[next++]!.promise);
    const lane = new BrowserInputLane(dispatch, vi.fn(), () => 4);
    lane.authority(1, 'you', true);
    for (let n = 0; n < 4; n++) { lane.send(text(String(n))); await settle(); }
    expect(dispatch).toHaveBeenCalledTimes(4);
    lane.send({ kind: 'clipboard', operation: 'copy' });
    lane.send(text('after-copy'));
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(4);
    // Out-of-order receipts must not reorder writes or release the clipboard early.
    for (const index of [2, 0, 3]) { pending[index]!.resolve(1); await settle(); }
    expect(dispatch).toHaveBeenCalledTimes(4);
    pending[1]!.resolve(1); await settle();
    expect(dispatch.mock.calls[4]?.[1]).toEqual({ kind: 'clipboard', operation: 'copy' });
    expect(dispatch).toHaveBeenCalledTimes(5);
    pending[4]!.resolve(1); await settle();
    expect(dispatch.mock.calls[5]?.[1]).toEqual(text('after-copy'));
    pending[5]!.resolve(1); await settle(); lane.destroy();
  });
  it('drops pipelined authority on failure without replaying or accepting late receipts', async () => {
    const first = deferred<number>(), second = deferred<number>(), interrupted = vi.fn();
    const dispatch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, interrupted, () => 4);
    lane.authority(1, 'you', true);
    lane.send(text('first')); await settle(); lane.send(text('second')); await settle();
    first.reject(new Error('lost receipt')); await settle();
    second.resolve(1); await settle();
    lane.send(text('must not replay')); await settle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(interrupted).toHaveBeenCalledTimes(1);
    lane.resume(); lane.send(text('fresh intent')); await settle();
    expect(dispatch).toHaveBeenCalledTimes(3);
    lane.destroy();
  });
  it('coalesces composition updates but preserves their commit and scroll targets/modifiers', async () => {
    const pending = deferred<number>(), dispatch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, 'you', true);
    lane.send(text('blocking'));
    lane.send({ kind: 'composition', text: 'に', selectionStart: 1, selectionEnd: 1 });
    lane.send({ kind: 'composition', text: '日本', selectionStart: 2, selectionEnd: 2 });
    lane.send(text('日本語'));
    const wheel = { kind: 'wheel' as const, x: 10, y: 20, deltaX: 0, deltaY: 1, modifiers: 0 };
    lane.send(wheel); lane.send(wheel);
    lane.send({ ...wheel, x: 200 });
    lane.send({ ...wheel, x: 200, modifiers: 2 });
    pending.resolve(1);
    await pending.promise; await settle();
    expect(dispatch.mock.calls[1]?.[1]).toEqual({ kind: 'batch', events: [
      { kind: 'composition', text: '日本', selectionStart: 2, selectionEnd: 2 }, text('日本語'),
      { ...wheel, deltaY: 2 }, { ...wheel, x: 200 }, { ...wheel, x: 200, modifiers: 2 },
    ] });
    lane.destroy();
  });
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
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    const pending = deferred<number>();
    dispatch.mockReturnValueOnce(pending.promise);
    lane.send(text("c"));
    lane.send(text("private queued text"));
    lane.authority(3, "agent", true);
    pending.resolve(2);
    await pending.promise;
    await settle();
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
    await settle();
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
    for (let i = 0; i < 12; i++) await settle();
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
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(interrupted).toHaveBeenCalledTimes(1);
    lane.destroy();
  });
  it("requires explicit interaction after uncertain delivery", async () => {
    const pending = deferred<number>(), dispatch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(1);
    const lane = new BrowserInputLane(dispatch, vi.fn());
    lane.authority(1, 'you', true); lane.send(text('uncertain'));
    pending.reject(new Error('lost receipt')); await pending.promise.catch(() => undefined); await settle();
    lane.authority(1, 'you', true); lane.send(text('never continue automatically'));
    expect(dispatch).toHaveBeenCalledTimes(1); expect(lane.needsInteraction).toBe(true);
    lane.resume(); lane.send(text('explicit page focus'));
    await settle(); await settle(); expect(dispatch).toHaveBeenCalledTimes(2);
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
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[1]).toMatchObject({ x: 99 });
    lane.destroy();
  });
});
