import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { toast } from 'ngx-sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Z_MODAL_DATA, ZardDialogService } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { TaskCompletionService } from './task-completion.service';
import { TaskFinishComponent } from './task-finish.component';
import { TaskReleaseComponent } from './task-release.component';
import { Task, TaskReleasePreview } from './task.model';
import { TasksApiService } from './tasks-api.service';
import { TaskUiService } from './task-ui.service';

describe('Task finish confirmation', () => {
  const task = { id: 7, name: 'Example', path: '/repo/task', linkStatus: 'linked' } as Task;
  const api = { get: vi.fn(), preview: vi.fn(), releasePreview: vi.fn() };
  const editors = { checkTaskEditors: vi.fn() };
  const completion = { finish: vi.fn(), releaseWorktree: vi.fn() };
  const dialog = { create: vi.fn() };
  let closed: Subject<boolean | TaskReleasePreview | undefined>;
  let service: TaskUiService;

  beforeEach(() => {
    vi.resetAllMocks();
    closed = new Subject();
    api.get.mockReturnValue(of(task));
    api.preview.mockReturnValue(of({ agents: 0, terminals: 1, actions: 0 }));
    editors.checkTaskEditors.mockResolvedValue(0);
    completion.finish.mockResolvedValue(task);
    completion.releaseWorktree.mockResolvedValue(task);
    dialog.create.mockReturnValue({ afterClosed: () => closed });
    TestBed.configureTestingModule({
      imports: [TaskFinishComponent, TaskReleaseComponent],
      providers: [
        { provide: TasksApiService, useValue: api },
        { provide: VSCodeWebStateService, useValue: editors },
        { provide: TaskCompletionService, useValue: completion },
        { provide: ZardDialogService, useValue: dialog },
        {
          provide: Z_MODAL_DATA,
          useValue: { task, taskId: task.id, agents: 0, terminals: 1, actions: 0, dirtyEditors: 1 },
        },
        {
          provide: ZardDialogRef,
          useValue: {
            close: (result?: boolean | TaskReleasePreview) => closed.next(result),
            afterClosed: () => closed,
          },
        },
      ],
    });
    service = TestBed.inject(TaskUiService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove('dark');
  });

  it.each(['light', 'dark'])(
    'dismisses immediately before saving or cleanup in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      let saved!: (count: number) => void;
      let finished!: (task: Task) => void;
      editors.checkTaskEditors.mockImplementation((_path, save) =>
        save ? new Promise<number>((resolve) => (saved = resolve)) : Promise.resolve(1),
      );
      completion.finish.mockReturnValue(new Promise<Task>((resolve) => (finished = resolve)));
      const pending = service.finish(task.id);
      await vi.waitFor(() => expect(dialog.create).toHaveBeenCalledOnce());
      const fixture = TestBed.createComponent(TaskFinishComponent);
      fixture.detectChanges();
      const dismiss = vi.fn();
      closed.subscribe((result) => {
        dismiss(result);
        fixture.destroy();
      });
      const button = [...fixture.nativeElement.querySelectorAll('button')].find((button: any) =>
        button.textContent.includes('Save and finish'),
      ) as HTMLButtonElement;
      button.click();
      expect(dismiss).toHaveBeenCalledWith(true);
      expect(completion.finish).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(editors.checkTaskEditors).toHaveBeenCalledWith(task.path, true),
      );
      expect(service.finishing().has(task.id)).toBe(true);
      await service.finish(task.id);
      expect(api.get).toHaveBeenCalledOnce();
      saved(0);
      await vi.waitFor(() => expect(completion.finish).toHaveBeenCalledWith(task, true));
      expect(service.finishing().has(task.id)).toBe(true);
      finished(task);
      await pending;
      expect(service.finishing().has(task.id)).toBe(false);
    },
  );

  it('leaves the task alone when the dialog is cancelled', async () => {
    const pending = service.finish(task.id);
    await vi.waitFor(() => expect(dialog.create).toHaveBeenCalledOnce());
    closed.next(undefined);
    await pending;
    expect(editors.checkTaskEditors).not.toHaveBeenCalledWith(task.path, true);
    expect(completion.finish).not.toHaveBeenCalled();
    expect(service.finishing().has(task.id)).toBe(false);
  });

  it('opens release immediately, owns it until close, and prevents duplicate task operations', async () => {
    const pending = service.releaseWorktree(task.id);
    expect(dialog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zContent: TaskReleaseComponent,
        zData: { taskId: task.id, taskName: undefined },
        zAriaLabel: 'Release worktree',
      }),
    );
    expect(api.get).not.toHaveBeenCalled();
    await service.releaseWorktree(task.id);
    await service.finish(task.id);
    expect(dialog.create).toHaveBeenCalledOnce();
    const config = dialog.create.mock.calls[0][0];
    expect(config.zOnCancel({ busy: () => true })).toBe(false);
    expect(config.zOnCancel({ busy: () => false })).toBeUndefined();
    closed.next(undefined);
    await pending;
    expect(service.releasing().size).toBe(0);
    expect(completion.finish).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'])(
    'continues releasing after the dialog is destroyed in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const preview = {
        task,
        agents: 1,
        terminals: 0,
        actions: 0,
        checkoutToken: 'checkout-1',
        alreadyReleased: false,
        cleanupRequired: false,
      } satisfies TaskReleasePreview;
      const loading = vi.spyOn(toast, 'loading').mockReturnValue('release-progress');
      const dismiss = vi.spyOn(toast, 'dismiss');
      let finish!: () => void;
      completion.releaseWorktree.mockReturnValue(
        new Promise<void>((resolve) => (finish = resolve)),
      );
      api.releasePreview.mockReturnValue(of(preview));
      const pending = service.releaseWorktree(task.id);
      const fixture = TestBed.createComponent(TaskReleaseComponent);
      await vi.waitFor(() => expect(fixture.componentInstance.checking()).toBe(false));
      closed.subscribe(() => fixture.destroy());
      await fixture.componentInstance.release();
      await vi.waitFor(() =>
        expect(completion.releaseWorktree).toHaveBeenCalledWith(task, true, 'checkout-1'),
      );
      expect(loading).toHaveBeenCalledWith('Releasing worktree…', {
        description: task.name,
        duration: Infinity,
      });
      expect(service.releasing().has(task.id)).toBe(true);
      await service.releaseWorktree(task.id);
      await service.finish(task.id);
      expect(dialog.create).toHaveBeenCalledOnce();
      expect(completion.releaseWorktree).toHaveBeenCalledOnce();
      expect(completion.finish).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      finish();
      await pending;
      expect(service.releasing().has(task.id)).toBe(false);
      expect(dismiss).toHaveBeenCalledWith('release-progress');
    },
  );

  it.each([undefined, 0, 500])(
    'reports a background release failure (%s status) and allows retry',
    async (status) => {
      const errorToast = vi.spyOn(toast, 'error').mockReturnValue('error');
      vi.spyOn(toast, 'loading').mockReturnValue('release-progress');
      const dismiss = vi.spyOn(toast, 'dismiss');
      completion.releaseWorktree.mockRejectedValueOnce({
        status,
        error: { message: 'Running work started. Check again.' },
      });
      const pending = service.releaseWorktree(task.id);
      closed.next({
        task,
        agents: 0,
        terminals: 0,
        actions: 0,
        checkoutToken: 'checkout-1',
      } as TaskReleasePreview);
      await pending;
      expect(errorToast).toHaveBeenCalledWith('Could not release worktree', {
        description:
          status === undefined
            ? 'Running work started. Check again.'
            : 'Could not confirm the release with the server. Check again to see whether the worktree was released.',
      });
      expect(dismiss).toHaveBeenCalledWith('release-progress');
      expect(service.releasing().has(task.id)).toBe(false);
      const retry = service.releaseWorktree(task.id);
      expect(dialog.create).toHaveBeenCalledTimes(2);
      closed.next(undefined);
      await retry;
    },
  );

  it.each([0, 1])(
    'does not inspect editors in a released checkout when finishing its former task (%s agents)',
    async (agents) => {
      api.get.mockReturnValue(of({ ...task, taskState: 'released', linkStatus: 'unlinked' }));
      api.preview.mockReturnValue(of({ agents, terminals: 0, actions: 0 }));
      const pending = service.finish(task.id);
      if (agents) {
        await vi.waitFor(() => expect(dialog.create).toHaveBeenCalledOnce());
        closed.next(true);
      }
      await pending;
      expect(editors.checkTaskEditors).not.toHaveBeenCalled();
      expect(completion.finish).toHaveBeenCalled();
    },
  );

  it.each(['save', 'finish'])('reports a background %s failure and allows retry', async (step) => {
    const errorToast = vi.spyOn(toast, 'error').mockReturnValue('error');
    const error = new Error('Could not complete operation');
    if (step === 'save')
      editors.checkTaskEditors.mockResolvedValueOnce(1).mockRejectedValueOnce(error);
    else completion.finish.mockRejectedValueOnce(error);
    const pending = service.finish(task.id);
    await vi.waitFor(() => expect(dialog.create).toHaveBeenCalledOnce());
    closed.next(true);
    await pending;
    expect(errorToast).toHaveBeenCalledWith('Could not finish task', {
      description: error.message,
    });
    if (step === 'save') expect(completion.finish).not.toHaveBeenCalled();
    expect(service.finishing().has(task.id)).toBe(false);
  });
});
