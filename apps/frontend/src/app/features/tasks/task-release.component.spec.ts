import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { TasksApiService } from './tasks-api.service';
import { TaskReleasePreview } from './task.model';
import { TaskReleaseComponent } from './task-release.component';

describe('Worktree release dialog', () => {
  const preview = {
    task: { id: 7, name: 'Example', path: '/checkout', linkStatus: 'linked', taskState: 'ready' },
    alreadyReleased: false,
    cleanupRequired: false,
    checkoutToken: 'checkout-1',
    agents: 0,
    terminals: 0,
    actions: 0,
  } as TaskReleasePreview;
  const api = { releasePreview: vi.fn() };
  const editors = { checkTaskEditors: vi.fn() };
  let closed: Subject<TaskReleasePreview | undefined>;
  let close: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetAllMocks();
    closed = new Subject();
    close = vi.fn((result) => closed.next(result));
    api.releasePreview.mockReturnValue(of(preview));
    editors.checkTaskEditors.mockResolvedValue(0);
    TestBed.configureTestingModule({
      imports: [TaskReleaseComponent],
      providers: [
        { provide: Z_MODAL_DATA, useValue: { taskId: 7, taskName: 'Example' } },
        { provide: ZardDialogRef, useValue: { afterClosed: () => closed, close } },
        { provide: TasksApiService, useValue: api },
        { provide: VSCodeWebStateService, useValue: editors },
      ],
    });
  });
  afterEach(() => document.documentElement.classList.remove('dark'));

  it.each(['light', 'dark'])(
    'shows loading immediately, then a clean confirmation in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const pending = new Subject<TaskReleasePreview>();
      api.releasePreview.mockReturnValue(pending);
      const fixture = TestBed.createComponent(TaskReleaseComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Checking worktree…');
      expect(fixture.nativeElement.textContent).toContain('Example');
      expect(fixture.nativeElement.querySelector('button:last-child').disabled).toBe(true);
      pending.next(preview);
      await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-release-ready]')).not.toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('Commit');
      expect(fixture.nativeElement.textContent).not.toContain('Git operations');
      expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('shows a specific failed check and allows retry without stopping work', async () => {
    api.releasePreview.mockReturnValueOnce(
      throwError(() => ({
        error: { message: 'This worktree has local changes. Commit or stash them.' },
      })),
    );
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'local changes',
    );
    expect(fixture.nativeElement.textContent).toContain('Check again');
    expect(close).not.toHaveBeenCalled();
    await fixture.componentInstance.check();
    expect(fixture.componentInstance.error()).toBe('');
    expect(fixture.componentInstance.preview()).toEqual(preview);
  });

  it('blocks unsaved editors without saving documents or calling release', async () => {
    editors.checkTaskEditors.mockResolvedValue(2);
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
    expect(fixture.componentInstance.error()).toContain('2 unsaved editor documents');
    await fixture.componentInstance.release();
    expect(close).not.toHaveBeenCalled();
    expect(editors.checkTaskEditors).toHaveBeenCalledExactlyOnceWith('/checkout');
  });

  it('ignores late editor checks after cancellation', async () => {
    let resolveEditors!: (count: number) => void;
    editors.checkTaskEditors.mockReturnValue(
      new Promise<number>((resolve) => (resolveEditors = resolve)),
    );
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    await vi.waitFor(() => expect(editors.checkTaskEditors).toHaveBeenCalledOnce());
    fixture.componentInstance.cancel();
    resolveEditors(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.componentInstance.preview()).toBeNull();
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it('cancels an in-flight HTTP check when dismissed', async () => {
    const pending = new Subject<TaskReleasePreview>();
    api.releasePreview.mockReturnValue(pending);
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    expect(pending.observed).toBe(true);
    fixture.componentInstance.cancel();
    expect(pending.observed).toBe(false);
    pending.next(preview);
    expect(editors.checkTaskEditors).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'])(
    'returns confirmation and dismisses before cleanup in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const running = { ...preview, agents: 1 };
      api.releasePreview.mockReturnValue(of(running));
      const fixture = TestBed.createComponent(TaskReleaseComponent);
      await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
      await fixture.componentInstance.release();
      expect(close).toHaveBeenCalledExactlyOnceWith(running);
      await fixture.componentInstance.release();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('prevents duplicate confirmation while rechecking editors', async () => {
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
    let finish!: (count: number) => void;
    editors.checkTaskEditors.mockReturnValue(new Promise<number>((resolve) => (finish = resolve)));
    const operation = fixture.componentInstance.release();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Checking editors…');
    fixture.componentInstance.cancel();
    await fixture.componentInstance.release();
    expect(close).not.toHaveBeenCalled();
    expect(editors.checkTaskEditors).toHaveBeenCalledTimes(2);
    finish(0);
    await operation;
    expect(close).toHaveBeenCalledExactlyOnceWith(preview);
  });

  it('checks for newly unsaved documents at confirmation', async () => {
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
    editors.checkTaskEditors.mockResolvedValue(1);
    await fixture.componentInstance.release();
    expect(fixture.componentInstance.error()).toContain('unsaved editor document');
    expect(close).not.toHaveBeenCalled();
    expect(fixture.componentInstance.busy()).toBe(false);
  });

  it('shows already released without accessing the former checkout', async () => {
    api.releasePreview.mockReturnValue(of({ ...preview, alreadyReleased: true }));
    const fixture = TestBed.createComponent(TaskReleaseComponent);
    await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('already been released');
    expect(editors.checkTaskEditors).not.toHaveBeenCalled();
    await fixture.componentInstance.release();
    expect(close).not.toHaveBeenCalled();
  });
});
