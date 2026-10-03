import type { ChangeReviewFileWindow } from '@/shared/models/change-review.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChangeReviewWindowLoader,
  type WindowRequest,
} from './change-review-window-loader.service';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const request = (path: string): WindowRequest => ({
  generation: 1,
  filePath: path,
  offset: 0,
  key: path,
  args: ['/repo', 'branch', path, { offset: 0, limit: 700 }, false],
});

// The view's row/cache behavior is covered by the panel tests; these exercise IO lifetime.
describe('ChangeReviewWindowLoader', () => {
  const responses = new Map<string, Subject<ChangeReviewFileWindow>>();
  const getFileWindow = vi.fn(
    (_worktree: string, _scope: string, path: string) => responses.get(path)!,
  );
  let loader: ChangeReviewWindowLoader;

  beforeEach(() => {
    responses.clear();
    getFileWindow.mockClear();
    for (const path of ['a', 'b', 'c']) responses.set(path, new Subject());
    TestBed.configureTestingModule({
      providers: [
        ChangeReviewWindowLoader,
        { provide: ChangeReviewService, useValue: { getFileWindow } },
      ],
    });
    loader = TestBed.inject(ChangeReviewWindowLoader);
  });

  it('deduplicates pending windows, runs one at a time, and honors priority', async () => {
    loader.enqueue(request('a'), false);
    loader.enqueue(request('a'), false);
    loader.enqueue(request('b'), false);
    loader.enqueue(request('c'), true);
    expect(getFileWindow).toHaveBeenCalledTimes(1);
    expect(loader.state()).toEqual({ running: true, total: 3 });
    responses.get('a')!.next({} as ChangeReviewFileWindow);
    await flush();
    expect(getFileWindow.mock.calls.map((call) => call[2])).toEqual(['a', 'c']);
    responses.get('c')!.next({} as ChangeReviewFileWindow);
    await flush();
    expect(getFileWindow.mock.calls.map((call) => call[2])).toEqual(['a', 'c', 'b']);
  });

  it('cancels obsolete subscriptions and accepts the same key in a new scope', async () => {
    const events: string[] = [];
    loader.events.subscribe((event) => events.push(event.type));
    loader.enqueue(request('a'), false);
    const oldResponse = responses.get('a')!;
    loader.reset();
    expect(oldResponse.observed).toBe(false);
    responses.set('a', new Subject());
    loader.enqueue({ ...request('a'), generation: 2 }, false);
    oldResponse.next({} as ChangeReviewFileWindow);
    await flush();
    expect(events).toEqual(['started', 'started']);
    expect(loader.state()).toEqual({ running: true, total: 1 });
    responses.get('a')!.next({} as ChangeReviewFileWindow);
    await flush();
    expect(events).toEqual(['started', 'started', 'loaded', 'finished']);
    expect(loader.state()).toEqual({ running: false, total: 0 });
  });

  it('prunes queued offscreen windows while keeping the in-flight request', async () => {
    loader.enqueue(request('a'), false);
    loader.enqueue(request('b'), false);
    loader.enqueue(request('c'), false);
    loader.prune(new Set(['c']), 1);
    expect(loader.has('a')).toBe(true);
    expect(loader.has('b')).toBe(false);
    responses.get('a')!.next({} as ChangeReviewFileWindow);
    await flush();
    expect(getFileWindow.mock.calls.map((call) => call[2])).toEqual(['a', 'c']);
  });
});
