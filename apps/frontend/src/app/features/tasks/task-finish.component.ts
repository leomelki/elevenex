import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { Task } from './task.model';

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
  cancel() {
    this.dialog.close();
  }
  finish() {
    this.dialog.close(true);
  }
}
