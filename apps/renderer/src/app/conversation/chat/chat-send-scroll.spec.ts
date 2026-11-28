import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSendScroll } from './chat-send-scroll';

interface Clock {
  progress: number;
  currentTime: number;
  effect: { getComputedTiming(): { progress: number } };
  onfinish: (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
  id: string;
}

describe('send scroll ownership', () => {
  const frames = new Map<number, FrameRequestCallback>();
  const clocks: Clock[] = [];
  let nextFrame = 0;
  let viewport: HTMLElement;
  let height = 600;
  beforeEach(() => {
    frames.clear(); clocks.length = 0; nextFrame = 0; height = 600;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrame; frames.set(id, callback); return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    viewport = document.createElement('div');
    viewport.style.overflowAnchor = 'auto';
    viewport.scrollTop = 100;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height }, clientHeight: { value: 400 },
      animate: { value: vi.fn(() => {
        const clock: Clock = {
          progress: 0, currentTime: 0, id: '', cancel: vi.fn(), onfinish: null,
          effect: { getComputedTiming: () => ({ progress: clock.progress }) },
        };
        clocks.push(clock); return clock;
      }) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  function paint(progress: number, age: number): void {
    const clock = clocks.at(-1)!;
    clock.progress = progress; clock.currentTime = age;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(age);
  }
  it('opens room from the painted position, retargets growth without a jump, and settles at the real end', () => {
    const settled = vi.fn();
    const reveal = new ChatSendScroll(viewport, 100, 340, 'ease-in-out', 140, settled);
    expect(viewport.scrollTop).toBe(100);
    expect(viewport.style.overflowAnchor).toBe('none');
    paint(.25, 100);
    expect(viewport.scrollTop).toBe(125);
    height += 40;
    reveal.reconcile();
    expect(viewport.scrollTop).toBe(125);
    expect(clocks[0]?.cancel).toHaveBeenCalledOnce();
    expect(clocks[0]?.onfinish).toBeNull();
    paint(.5, 100);
    expect(viewport.scrollTop).toBe(182.5);
    clocks.at(-1)?.onfinish?.();
    expect(viewport.scrollTop).toBe(240);
    expect(viewport.style.overflowAnchor).toBe('auto');
    expect(settled).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    reveal.cancel();
    expect(settled).toHaveBeenCalledOnce();
  });
  it('gives the reader the current position on interruption and releases every resource', () => {
    const settled = vi.fn();
    const reveal = new ChatSendScroll(viewport, 100, 340, 'ease-in-out', 140, settled);
    paint(.4, 150);
    reveal.cancel();
    expect(viewport.scrollTop).toBe(140);
    expect(viewport.style.overflowAnchor).toBe('auto');
    expect(clocks[0]?.cancel).toHaveBeenCalledOnce();
    expect(clocks[0]?.onfinish).toBeNull();
    expect(frames.size).toBe(0);
    expect(settled).not.toHaveBeenCalled();
    height += 200; reveal.reconcile();
    expect(clocks).toHaveLength(1);
    expect(viewport.scrollTop).toBe(140);
  });
  it('eases growth arriving at the end of the clock rather than snapping to a later target', () => {
    const settled = vi.fn();
    const reveal = new ChatSendScroll(viewport, 100, 340, 'ease-in-out', 140, settled);
    paint(.95, 320);
    height += 60;
    clocks.at(-1)?.onfinish?.();
    expect(viewport.scrollTop).toBe(195);
    expect(settled).not.toHaveBeenCalled();
    paint(.5, 70);
    expect(viewport.scrollTop).toBe(227.5);
    clocks.at(-1)?.onfinish?.();
    expect(viewport.scrollTop).toBe(260);
    expect(settled).toHaveBeenCalledOnce();
    reveal.cancel();
  });
  it('keeps a full curve for a large retarget after a long composer shrinks', () => {
    const reveal = new ChatSendScroll(viewport, 100, 340, 'ease-in-out', 140, vi.fn());
    paint(.9, 320);
    height += 400;
    reveal.reconcile();
    expect(viewport.scrollTop).toBe(190);
    expect(viewport.animate).toHaveBeenLastCalledWith(expect.any(Array),
      expect.objectContaining({ duration: 340 }));
    reveal.cancel();
  });
});
