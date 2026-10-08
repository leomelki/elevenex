import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksApiService } from './tasks-api.service';
import { TaskDraftService } from './task-draft.service';

describe('Task drafts', () => {
  const api = { draft: vi.fn() };
  beforeEach(() => {
    api.draft.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: TasksApiService, useValue: api }] });
  });
  it('saves drafts in order, including a final save requested while leaving the page', async () => {
    const first = new Subject<{ saved: boolean }>();
    api.draft.mockReturnValueOnce(first).mockReturnValue(of({ saved: true }));
    const store = TestBed.inject(TaskDraftService);
    const one = store.save(42, 'First');
    const two = store.save(42, 'Last text before leaving');
    await Promise.resolve();
    await Promise.resolve();
    expect(api.draft).toHaveBeenCalledTimes(1);
    first.next({ saved: true });
    await one;
    await two;
    expect(api.draft.mock.calls).toEqual([
      [42, 'First'],
      [42, 'Last text before leaving'],
    ]);
  });
  it('allows retrying a save after a network error', async () => {
    const first = new Subject();
    api.draft.mockReturnValueOnce(first).mockReturnValue(of({ saved: true }));
    const store = TestBed.inject(TaskDraftService);
    const failed = store.save(42, 'Unsaved');
    const assertion = expect(failed).rejects.toThrow('Offline');
    await Promise.resolve();
    await Promise.resolve();
    first.error(new Error('Offline'));
    await assertion;
    await store.save(42, 'Unsaved');
    expect(api.draft).toHaveBeenCalledTimes(2);
  });
});
