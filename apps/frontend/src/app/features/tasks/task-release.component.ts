import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, takeUntil } from 'rxjs';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { TasksApiService } from './tasks-api.service';
import { TaskReleasePreview, taskError } from './task.model';

@Component({
  selector: 'app-task-release',
  imports: [A11yModule, ZardButtonComponent],
  templateUrl: './task-release.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskReleaseComponent {
  private readonly data: { taskId: number; taskName?: string } = inject(Z_MODAL_DATA);
  private readonly dialog = inject(ZardDialogRef);
  private readonly api = inject(TasksApiService);
  private readonly editors = inject(VSCodeWebStateService);
  private readonly destroyRef = inject(DestroyRef);
  private closed = false;
  private version = 0;
  readonly checking = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly preview = signal<TaskReleasePreview | null>(null);
  readonly taskName = signal(this.data.taskName ?? '');

  constructor() {
    this.dialog
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.closed = true;
      });
    void this.check();
  }

  private current(version: number) {
    return !this.closed && !this.destroyRef.destroyed && this.version === version;
  }

  private async checkEditors(path: string) {
    const count = await this.editors.checkTaskEditors(path);
    if (count)
      throw new Error(
        `Save or discard ${count === 1 ? 'the unsaved editor document' : `the ${count} unsaved editor documents`} before releasing this worktree.`,
      );
  }

  private errorMessage(error: unknown) {
    const status = (error as { status?: number })?.status;
    if (status === 0 || (status && status >= 500))
      return 'Could not check the worktree. Check your connection and try again.';
    return taskError(error);
  }

  async check() {
    if (this.busy() || this.checking() || this.closed) return;
    const version = ++this.version;
    this.checking.set(true);
    this.error.set('');
    this.preview.set(null);
    try {
      const preview = await firstValueFrom(
        this.api
          .releasePreview(this.data.taskId)
          .pipe(takeUntil(this.dialog.afterClosed()), takeUntilDestroyed(this.destroyRef)),
      );
      if (!this.current(version)) return;
      this.taskName.set(preview.task.name);
      if (!preview.alreadyReleased) await this.checkEditors(preview.task.path);
      if (this.current(version)) this.preview.set(preview);
    } catch (error) {
      if (this.current(version)) this.error.set(this.errorMessage(error));
    } finally {
      if (this.current(version)) this.checking.set(false);
    }
  }

  async release() {
    const preview = this.preview();
    if (!preview || preview.alreadyReleased || this.checking() || this.busy() || this.closed)
      return;
    this.busy.set(true);
    this.error.set('');
    try {
      // Editors can become dirty while confirmation is open. Never save them implicitly.
      await this.checkEditors(preview.task.path);
      if (this.closed || this.destroyRef.destroyed) return;
      // The task service owns cleanup after the confirmation is dismissed.
      this.dialog.close(preview);
    } catch (error) {
      if (!this.closed && !this.destroyRef.destroyed) {
        this.preview.set(null);
        this.error.set(this.errorMessage(error));
      }
    } finally {
      if (!this.closed && !this.destroyRef.destroyed) this.busy.set(false);
    }
  }

  cancel() {
    if (!this.busy()) this.dialog.close();
  }
}
