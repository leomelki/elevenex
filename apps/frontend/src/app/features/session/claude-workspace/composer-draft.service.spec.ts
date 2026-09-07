import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerDraftService } from './composer-draft.service';
import type { ComposerImageAttachment } from './components/claude-composer.component';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';

const DRAFT_URL = '/api/sessions/7/composer-draft';

describe('ComposerDraftService', () => {
  let service: ComposerDraftService;
  let http: HttpTestingController;

  const image = (): ComposerImageAttachment => ({
    id: 'img-1',
    name: 'screen.png',
    mediaType: 'image/png',
    dataUrl: 'data:image/png;base64,abc',
    size: 3,
  });

  const diffMention = (): DiffSelectionMention => ({
    id: 'mention-1',
    version: 1,
    scope: 'branch',
    compareLabel: 'feature vs main',
    baseSha: 'base',
    headSha: 'head',
    filePath: 'src/app.ts',
    oldPath: null,
    status: 'modified',
    changeHash: 'hash',
    oldLineStart: 1,
    oldLineEnd: 1,
    newLineStart: 2,
    newLineEnd: 2,
    selectedText: 'const value = true;',
    context: { before: [], selected: [], after: [] },
    truncated: false,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ComposerDraftService],
    });
    service = TestBed.inject(ComposerDraftService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads the draft the backend holds for the session', async () => {
    const loaded = service.load(7);
    http.expectOne({ method: 'GET', url: DRAFT_URL }).flush({
      sessionId: 7,
      text: 'Keep this draft',
      diffMentions: [diffMention()],
      sessionMentions: [],
      images: [image()],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });

    await expect(loaded).resolves.toEqual({
      sessionId: 7,
      text: 'Keep this draft',
      diffMentions: [diffMention()],
      sessionMentions: [],
      images: [image()],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });
  });

  it('returns null when the session has no draft', async () => {
    const loaded = service.load(7);
    http.expectOne({ method: 'GET', url: DRAFT_URL }).flush(null);

    await expect(loaded).resolves.toBeNull();
  });

  it('coalesces a burst of edits into one write', async () => {
    service.save({ sessionId: 7, text: 'a', diffMentions: [], images: [] });
    service.save({ sessionId: 7, text: 'ab', diffMentions: [], images: [] });
    service.save({ sessionId: 7, text: 'abc', diffMentions: [], images: [] });
    http.expectNone(DRAFT_URL);

    await vi.advanceTimersByTimeAsync(400);

    const request = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(request.request.body).toEqual({
      text: 'abc',
      diffMentions: [],
      sessionMentions: [],
      images: [],
    });
    request.flush({});
  });

  it('omits unchanged image attachments from subsequent writes', async () => {
    service.save({ sessionId: 7, text: 'with image', diffMentions: [], images: [image()] });
    await vi.advanceTimersByTimeAsync(400);
    const first = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(first.request.body).toMatchObject({ images: [image()] });
    first.flush({});

    service.save({ sessionId: 7, text: 'with image!', diffMentions: [], images: [image()] });
    await vi.advanceTimersByTimeAsync(400);
    const second = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(second.request.body).not.toHaveProperty('images');
    second.flush({});

    service.save({ sessionId: 7, text: 'no image', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    const third = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(third.request.body).toMatchObject({ images: [] });
    third.flush({});
  });

  it('deletes the draft when the composer is emptied or sent', async () => {
    service.delete(7);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne({ method: 'DELETE', url: DRAFT_URL }).flush({ deleted: true });

    service.save({ sessionId: 7, text: '   ', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    http.expectOne({ method: 'DELETE', url: DRAFT_URL }).flush({ deleted: true });
  });

  it('keeps one write in flight per session and follows it with the newest state', async () => {
    service.save({ sessionId: 7, text: 'first', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    const inFlight = http.expectOne({ method: 'PUT', url: DRAFT_URL });

    service.save({ sessionId: 7, text: 'second', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    // The first write has not answered yet, so nothing else may go out.
    http.expectNone(DRAFT_URL);

    inFlight.flush({});
    await vi.advanceTimersByTimeAsync(0);

    const followUp = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(followUp.request.body).toMatchObject({ text: 'second' });
    followUp.flush({});
  });

  it('retries a failed write so an unreachable backend does not lose the text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.save({ sessionId: 7, text: 'unsent', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    http
      .expectOne({ method: 'PUT', url: DRAFT_URL })
      .error(new ProgressEvent('error'), { status: 0, statusText: 'offline' });

    await vi.advanceTimersByTimeAsync(2_000);
    const retry = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(retry.request.body).toMatchObject({ text: 'unsent' });
    retry.flush({});
  });

  it('retries with what the user typed while the failing write was in flight', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.save({ sessionId: 7, text: 'first', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    const inFlight = http.expectOne({ method: 'PUT', url: DRAFT_URL });

    service.save({ sessionId: 7, text: 'first, then more', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    inFlight.error(new ProgressEvent('error'), { status: 0, statusText: 'offline' });

    await vi.advanceTimersByTimeAsync(2_000);
    const retry = http.expectOne({ method: 'PUT', url: DRAFT_URL });
    expect(retry.request.body).toMatchObject({ text: 'first, then more' });
    retry.flush({});
  });

  it('stops trying once the session is gone', async () => {
    service.save({ sessionId: 7, text: 'orphaned', diffMentions: [], images: [] });
    await vi.advanceTimersByTimeAsync(400);
    http
      .expectOne({ method: 'PUT', url: DRAFT_URL })
      .flush('Session with id 7 not found', { status: 404, statusText: 'Not Found' });

    await vi.advanceTimersByTimeAsync(10_000);
    http.expectNone(DRAFT_URL);
  });

  it('serves an unwritten edit back to the composer instead of the stored draft', async () => {
    service.save({ sessionId: 7, text: 'just typed', diffMentions: [], images: [] });

    await expect(service.load(7)).resolves.toMatchObject({ text: 'just typed' });
    http.expectNone(DRAFT_URL);

    await vi.advanceTimersByTimeAsync(400);
    http.expectOne({ method: 'PUT', url: DRAFT_URL }).flush({});
  });

  it('ignores invalid session ids', async () => {
    service.save({ sessionId: 0, text: 'nowhere', diffMentions: [], images: [] });
    service.delete(-1);
    await expect(service.load(0)).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(400);
    http.verify();
  });
});
