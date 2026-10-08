import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { Task, taskError } from './task.model';
import { TaskCompletionService } from './task-completion.service';

export interface TaskFinishData {
  task: Task;
  agents: number;
  terminals: number;
  actions: number;
  dirtyEditors: number;
}
@Component({
  selector: 'app-task-finish',
  imports: [A11yModule, ZardButtonComponent],
  templateUrl: './task-finish.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskFinishComponent {
  readonly data: TaskFinishData = inject(Z_MODAL_DATA);
  private readonly dialog = inject(ZardDialogRef);
  private readonly completion = inject(TaskCompletionService);
  private readonly editors = inject(VSCodeWebStateService);
  readonly busy = signal(false);
  readonly error = signal('');
  cancel() {
    if (this.busy()) return;
    this.dialog.close();
  }
  async finish() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.editors.checkTaskEditors(this.data.task.path, true);
      await this.completion.finish(this.data.task, true);
      this.dialog.close();
    } catch (error) {
      this.error.set(taskError(error));
      this.busy.set(false);
    }
  }
}
