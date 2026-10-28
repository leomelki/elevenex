import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { WorkspaceTask, WorkspaceTaskRecovery } from '@elevenex/shared';
import { ButtonComponent, IconComponent, ProgressLineComponent } from '../ui';

/** Presents one saved task's preparation and emits explicit recovery choices. */
@Component({
  selector: 'ex-workspace-task-setup',
  imports: [ButtonComponent, IconComponent, ProgressLineComponent],
  templateUrl: './workspace-task-setup.component.html',
  styleUrl: './workspace-task-setup.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceTaskSetupComponent {
  readonly task = input.required<WorkspaceTask>();
  readonly busy = input(false);
  readonly paused = input(false);
  readonly uncertain = input(false);
  readonly error = input<string | null>(null);
  readonly retryRequested = output<WorkspaceTaskRecovery | undefined>();
  readonly refreshRequested = output<void>();
}
