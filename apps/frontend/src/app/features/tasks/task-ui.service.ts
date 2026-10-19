import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { ZardDialogService } from '@/shared/components/dialog/dialog.service';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { TaskCreateComponent, TaskCreateData } from './task-create.component';
import { TaskFinishComponent } from './task-finish.component';
import { TaskReleaseComponent } from './task-release.component';
import { TaskCompletionService } from './task-completion.service';
import { TasksApiService } from './tasks-api.service';
import { TaskReleasePreview, taskError } from './task.model';

@Injectable({ providedIn: 'root' })
export class TaskUiService {
  private readonly dialog = inject(ZardDialogService);
  private readonly api = inject(TasksApiService);
  private readonly editors = inject(VSCodeWebStateService);
  private readonly completion = inject(TaskCompletionService);
  readonly finishing = signal(new Set<number>());
  readonly releasing = signal(new Set<number>());
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
    if (this.finishing().has(id) || this.releasing().has(id)) return;
    this.finishing.update((ids) => new Set(ids).add(id));
    try {
      const task = await firstValueFrom(this.api.get(id));
      const [counts, dirtyEditors] = await Promise.all([
        firstValueFrom(this.api.preview(id)),
        task.linkStatus === 'linked'
          ? this.editors.checkTaskEditors(task.path)
          : Promise.resolve(0),
      ]);
      if (counts.agents || counts.terminals || counts.actions || dirtyEditors) {
        const ref = this.dialog.create({
          zContent: TaskFinishComponent,
          zData: { task, ...counts, dirtyEditors },
          zHideFooter: true,
          zAriaLabel: 'Finish task',
          zWidth: 'min(460px, calc(100vw - 2rem))',
          zMaskClosable: false,
        });
        const confirmed = await firstValueFrom(ref.afterClosed());
        if (confirmed !== true) return;
        // Keep the operation owned by the service after the dialog is dismissed.
        if (task.linkStatus === 'linked') await this.editors.checkTaskEditors(task.path, true);
        await this.completion.finish(task, true);
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
  async releaseWorktree(id: number, taskName?: string) {
    if (this.releasing().has(id) || this.finishing().has(id)) return;
    this.releasing.update((ids) => new Set(ids).add(id));
    let progress: string | number | undefined;
    let confirmed: TaskReleasePreview | undefined;
    try {
      const ref = this.dialog.create({
        zContent: TaskReleaseComponent,
        zData: { taskId: id, taskName },
        zHideFooter: true,
        zAriaLabel: 'Release worktree',
        zWidth: 'min(460px, calc(100vw - 2rem))',
        zMaskClosable: false,
        zOnCancel: (instance) => (instance.busy() ? false : undefined),
      });
      confirmed = await firstValueFrom(ref.afterClosed());
      if (!confirmed) return;
      progress = toast.loading('Releasing worktree…', {
        description: confirmed.task.name,
        duration: Infinity,
      });
      await this.completion.releaseWorktree(
        confirmed.task,
        !!(confirmed.agents || confirmed.terminals || confirmed.actions),
        confirmed.checkoutToken,
      );
    } catch (error) {
      const status = (error as { status?: number })?.status;
      toast.error(confirmed ? 'Could not release worktree' : 'Could not open release dialog', {
        description:
          confirmed && (status === 0 || (status && status >= 500))
            ? 'Could not confirm the release with the server. Check again to see whether the worktree was released.'
            : taskError(error),
      });
    } finally {
      if (progress !== undefined) toast.dismiss(progress);
      this.releasing.update((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }
}
