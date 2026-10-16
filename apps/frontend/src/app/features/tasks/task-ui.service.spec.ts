import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { toast } from 'ngx-sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Z_MODAL_DATA, ZardDialogService } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { TaskCompletionService } from './task-completion.service';
import { TaskFinishComponent } from './task-finish.component';
import { Task } from './task.model';
import { TasksApiService } from './tasks-api.service';
import { TaskUiService } from './task-ui.service';

describe('Task finish confirmation', () => {
  const task = { id: 7, name: 'Example', path: '/repo/task' } as Task;
  const api = { get: vi.fn(), preview: vi.fn() };
  const editors = { checkTaskEditors: vi.fn() };
  const completion = { finish: vi.fn() };
  const dialog = { create: vi.fn() };
  let closed: Subject<boolean | undefined>;
  let service: TaskUiService;

  beforeEach(() => {
    vi.resetAllMocks();
    closed = new Subject();
    api.get.mockReturnValue(of(task));
    api.preview.mockReturnValue(of({ agents: 0, terminals: 1, actions: 0 }));
    editors.checkTaskEditors.mockResolvedValue(0);
    completion.finish.mockResolvedValue(task);
    dialog.create.mockReturnValue({ afterClosed: () => closed });
    TestBed.configureTestingModule({
      imports: [TaskFinishComponent],
      providers: [
        { provide: TasksApiService, useValue: api },
        { provide: VSCodeWebStateService, useValue: editors },
        { provide: TaskCompletionService, useValue: completion },
        { provide: ZardDialogService, useValue: dialog },
        {
          provide: Z_MODAL_DATA,
          useValue: { task, agents: 0, terminals: 1, actions: 0, dirtyEditors: 1 },
        },
        {
          provide: ZardDialogRef,
          useValue: { close: (result?: boolean) => closed.next(result) },
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
