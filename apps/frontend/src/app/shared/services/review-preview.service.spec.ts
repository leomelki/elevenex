import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewPreviewService } from './review-preview.service';

describe('ReviewPreviewService capabilities', () => {
  let preview: ReviewPreviewService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    preview = TestBed.inject(ReviewPreviewService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('coalesces simultaneous visualization requests while keeping review permissions separate', async () => {
    const first = preview.session('/tmp/charts', true);
    const url = preview.previewUrl('/tmp/charts', 'my chart.html', true);
    const request = http.expectOne('/api/review-preview/sessions');
    expect(request.request.body.visualization).toBe(true);
    request.flush({ previewId: 'viz', urlPrefix: 'http://backend.test/api/review-preview/p/viz/' });
    await expect(first).resolves.toMatchObject({ previewId: 'viz' });
    await expect(url).resolves.toBe('http://backend.test/api/review-preview/p/viz/my%20chart.html');
    await expect(preview.previewUrl('/tmp/charts', 'nested/', true)).resolves.toBe(
      'http://backend.test/api/review-preview/p/viz/nested/',
    );
    const review = preview.session('/tmp/charts');
    const reviewRequest = http.expectOne('/api/review-preview/sessions');
    expect(reviewRequest.request.body.visualization).toBeUndefined();
    reviewRequest.flush({ previewId: 'review', urlPrefix: '/api/review-preview/p/review/' });
    await expect(review).resolves.toMatchObject({ previewId: 'review' });
  });

  it('allows retries after failed creation and after backend capability invalidation', async () => {
    const failed = preview.session('/tmp/charts', true);
    const rejected = expect(failed).rejects.toBeDefined();
    http
      .expectOne('/api/review-preview/sessions')
      .flush({}, { status: 500, statusText: 'Server error' });
    await rejected;
    const retried = preview.session('/tmp/charts', true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'retry', urlPrefix: '/preview/' });
    await retried;
    preview.invalidateSession('/tmp/charts', true);
    const renewed = preview.session('/tmp/charts', true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'new', urlPrefix: '/preview/' });
    await expect(renewed).resolves.toMatchObject({ previewId: 'new' });
  });

  it('renews old capabilities before their backend lifetime elapses', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const initial = preview.session('/tmp/charts', true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'old', urlPrefix: '/preview/' });
    await initial;
    now.mockReturnValue(6 * 60 * 60 * 1000);
    const renewed = preview.session('/tmp/charts', true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'new', urlPrefix: '/preview/' });
    await expect(renewed).resolves.toMatchObject({ previewId: 'new' });
  });

  it('revalidates cached descriptors while coalescing concurrent fresh opens', async () => {
    const initial = preview.session('/tmp/charts', true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'old', urlPrefix: '/preview/' });
    await initial;
    const first = preview.session('/tmp/charts', true, true);
    const second = preview.session('/tmp/charts', true, true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'new', urlPrefix: '/preview/' });
    await expect(first).resolves.toMatchObject({ previewId: 'new' });
    await expect(second).resolves.toMatchObject({ previewId: 'new' });
  });

  it('does not let a superseded request failure erase its replacement', async () => {
    const first = preview.session('/tmp/charts', true);
    const rejected = expect(first).rejects.toBeDefined();
    const oldRequest = http.expectOne('/api/review-preview/sessions');
    preview.invalidateSession('/tmp/charts', true);
    const fresh = preview.session('/tmp/charts', true);
    const newRequest = http.expectOne('/api/review-preview/sessions');
    oldRequest.flush({}, { status: 500, statusText: 'Old request failed' });
    await rejected;
    newRequest.flush({ previewId: 'fresh', urlPrefix: '/preview/' });
    await fresh;
    await expect(preview.session('/tmp/charts', true)).resolves.toMatchObject({
      previewId: 'fresh',
    });
    http.expectNone('/api/review-preview/sessions');
  });

  it('cancels stalled session requests and permits a fresh retry', async () => {
    vi.useFakeTimers();
    try {
      const first = preview.session('/tmp/charts', true);
      const rejected = expect(first).rejects.toThrow('Timeout');
      const request = http.expectOne('/api/review-preview/sessions');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(request.cancelled).toBe(true);
      const second = preview.session('/tmp/charts', true);
      http
        .expectOne('/api/review-preview/sessions')
        .flush({ previewId: 'retry', urlPrefix: '/preview/' });
      await expect(second).resolves.toMatchObject({ previewId: 'retry' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces in-flight requests even when more than 32 directories open together', async () => {
    const loads = Array.from({ length: 64 }, (_, index) =>
      preview.session(`/tmp/chart-${index}`, true),
    );
    const repeat = preview.session('/tmp/chart-0', true, true);
    const requests = http.match('/api/review-preview/sessions');
    expect(requests).toHaveLength(64);
    requests.forEach((request, index) =>
      request.flush({ previewId: `id-${index}`, urlPrefix: '/preview/' }),
    );
    await Promise.all(loads);
    await expect(repeat).resolves.toMatchObject({ previewId: 'id-0' });
    const renewed = preview.session('/tmp/chart-0', true, true);
    http
      .expectOne('/api/review-preview/sessions')
      .flush({ previewId: 'id-0', urlPrefix: '/preview/' });
    await expect(renewed).resolves.toMatchObject({ previewId: 'id-0' });
  });
});
