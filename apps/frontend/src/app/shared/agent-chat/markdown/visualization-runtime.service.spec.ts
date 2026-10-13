import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewPreviewService } from '@/shared/services/review-preview.service';
import {
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
} from '@/shared/models/review-preview-bridge.model';
import { VisualizationRuntimeService } from './visualization-runtime.service';

describe('shared visualization runtime', () => {
  let runtime: VisualizationRuntimeService;
  let preview: { keepalive: ReturnType<typeof vi.fn> };
  const frames: HTMLIFrameElement[] = [];
  beforeEach(() => {
    preview = { keepalive: vi.fn().mockResolvedValue([]) };
    TestBed.configureTestingModule({
      providers: [{ provide: ReviewPreviewService, useValue: preview }],
    });
    runtime = TestBed.inject(VisualizationRuntimeService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    frames.splice(0).forEach((frame) => frame.remove());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.documentElement.classList.remove('dark');
  });
  const frame = () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frames.push(frame);
    return frame;
  };

  it('shares one message listener and one theme read across frames, then releases resources', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const styles = vi.spyOn(window, 'getComputedStyle');
    const first = frame(),
      second = frame();
    const receiveFirst = vi.fn(),
      receiveSecond = vi.fn();
    const unregisterFirst = runtime.register(first, 'first', receiveFirst, vi.fn());
    const unregisterSecond = runtime.register(second, 'second', receiveSecond, vi.fn());
    expect(add.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);
    runtime.initialize(first);
    runtime.initialize(second);
    expect(styles).toHaveBeenCalledTimes(1);
    const reply = (source: Window, previewId: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          data: { ex: PREVIEW_BRIDGE_CHANNEL, v: PREVIEW_BRIDGE_VERSION, previewId, type: 'ready' },
        }),
      );
    reply(first.contentWindow!, 'wrong-id');
    reply(window, 'first');
    expect(receiveFirst).not.toHaveBeenCalled();
    reply(first.contentWindow!, 'first');
    expect(receiveFirst).toHaveBeenCalledTimes(1);
    expect(receiveSecond).not.toHaveBeenCalled();
    document.documentElement.classList.add('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(styles).toHaveBeenCalledTimes(2);
    unregisterFirst();
    unregisterSecond();
    expect(remove.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);
    document.documentElement.classList.remove('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(styles).toHaveBeenCalledTimes(2);
  });

  it('shares viewport observation and never loads an unmounted waiting artifact', () => {
    let intersect!: IntersectionObserverCallback;
    const construct = vi.fn(),
      observe = vi.fn(),
      unobserve = vi.fn(),
      disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          construct();
          intersect = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
    const first = document.createElement('div'),
      second = document.createElement('div');
    const showFirst = vi.fn(),
      showSecond = vi.fn();
    const stopFirst = runtime.whenVisible(first, showFirst);
    runtime.whenVisible(second, showSecond);
    expect(construct).toHaveBeenCalledTimes(1);
    stopFirst();
    intersect(
      [
        { target: first, isIntersecting: true } as unknown as IntersectionObserverEntry,
        { target: second, isIntersecting: true } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    expect(showFirst).not.toHaveBeenCalled();
    expect(showSecond).toHaveBeenCalledTimes(1);
    expect(unobserve).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('batches duplicate capability heartbeats and stops after the last frame closes', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const stopFirst = runtime.register(frame(), 'shared', vi.fn(), expired);
    const stopSecond = runtime.register(frame(), 'shared', vi.fn(), expired);
    preview.keepalive.mockResolvedValueOnce(['shared']);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(preview.keepalive).toHaveBeenCalledExactlyOnceWith(['shared']);
    expect(expired).toHaveBeenCalledTimes(2);
    stopFirst();
    stopSecond();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(preview.keepalive).toHaveBeenCalledTimes(1);
  });

  it('ignores heartbeat results for frames removed while the request was pending', async () => {
    vi.useFakeTimers();
    let resolve!: (ids: string[]) => void;
    preview.keepalive.mockImplementation(
      () =>
        new Promise<string[]>((done) => {
          resolve = done;
        }),
    );
    const expired = vi.fn();
    const stop = runtime.register(frame(), 'id', vi.fn(), expired);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    stop();
    resolve(['id']);
    await Promise.resolve();
    expect(expired).not.toHaveBeenCalled();
  });
});
