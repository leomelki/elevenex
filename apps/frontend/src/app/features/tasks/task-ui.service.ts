import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { ZardDialogService } from '@/shared/components/dialog/dialog.service';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { TaskCreateComponent, TaskCreateData } from './task-create.component';
import { TaskFinishComponent } from './task-finish.component';
import { TaskCompletionService } from './task-completion.service';
import { TasksApiService } from './tasks-api.service';
import { taskError } from './task.model';

@Injectable({ providedIn: 'root' })
export class TaskUiService {
  private readonly dialog = inject(ZardDialogService);
  private readonly api = inject(TasksApiService);
  private readonly editors = inject(VSCodeWebStateService);
  private readonly completion = inject(TaskCompletionService);
  readonly finishing = signal(new Set<number>());
  create(data: TaskCreateData) {
    return this.dialog.create({
      zContent: TaskCreateComponent,
      zData: data,
      zHideFooter: true,
      zAriaLabel: 'New task',
      zWidth: 'min(540px, calc(100vw - 2rem))',
      zCustomClasses: 'sm:max-w-[540px] max-h-[90dvh] overflow-y-auto',
      zMaskClosable: false,
      zOnCancel: (instance) => (instance.busy() ? false : undefined),
    });
  }
  async finish(id: number) {
    if (this.finishing().has(id)) return;
    this.finishing.update((ids) => new Set(ids).add(id));
    try {
      const task = await firstValueFrom(this.api.get(id));
      const [counts, dirtyEditors] = await Promise.all([
        firstValueFrom(this.api.preview(id)),
        this.editors.checkTaskEditors(task.path),
      ]);
      if (counts.agents || counts.terminals || counts.actions || dirtyEditors) {
        const ref = this.dialog.create({
          zContent: TaskFinishComponent,
          zData: { task, ...counts, dirtyEditors },
          zHideFooter: true,
          zAriaLabel: 'Finish task',
          zWidth: 'min(460px, calc(100vw - 2rem))',
          zMaskClosable: false,
          zOnCancel: (instance) => (instance.busy() ? false : undefined),
        });
        await firstValueFrom(ref.afterClosed());
      } else await this.completion.finish(task, false);
    } catch (error) {
      toast.error('Could not finish task', { description: taskError(error) });
    } finally {
      this.finishing.update((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }
}
