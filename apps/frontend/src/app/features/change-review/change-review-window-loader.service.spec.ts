import type { ChangeReviewFileWindow } from '@/shared/models/change-review.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { TestBed } from '@angular/core/testing';
import { toast } from 'ngx-sonner';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChangeReviewWindowLoader,
  type WindowRequest,
} from './change-review-window-loader.service';

vi.mock('ngx-sonner', () => ({ toast: { error: vi.fn() } }));

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
    vi.mocked(toast.error).mockClear();
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

  it('stops obsolete queued windows and reports stale scope without an error toast', async () => {
    const events: string[] = [];
    loader.events.subscribe((event) => events.push(event.type));
    loader.enqueue(request('a'), false);
    loader.enqueue(request('b'), false);
    responses.get('a')!.error({
      error: { message: 'File is not changed in this scope: a' },
    });
    await flush();

    expect(events).toEqual(['started', 'stale']);
    expect(getFileWindow).toHaveBeenCalledTimes(1);
    expect(loader.state()).toEqual({ running: false, total: 0 });
    expect(loader.has('b')).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not retry failed windows on redraw, but allows retry after refresh', async () => {
    loader.events.subscribe((event) => {
      if (event.type === 'finished') loader.enqueue(event.request, false);
    });
    loader.enqueue(request('a'), false);
    responses.get('a')!.error({ error: { message: 'Could not read file' } });
    await flush();
    loader.enqueue(request('a'), true);

    expect(getFileWindow).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not read file');
    expect(loader.state()).toEqual({ running: false, total: 0 });

    loader.reset();
    responses.set('a', new Subject());
    loader.enqueue({ ...request('a'), generation: 2 }, false);
    expect(getFileWindow).toHaveBeenCalledTimes(2);
  });
});
