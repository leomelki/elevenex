import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { WorkspaceTask } from '@elevenex/shared';
import { ButtonComponent } from '../src/app/ui';
import { TaskListComponent, type TaskOutline } from '../src/app/tasks';
import { WorkspaceTaskSetupComponent, workspaceTaskSignal } from '../src/app/workspace';

type SetupMoment = 'queued' | 'fetching' | 'waiting' | 'checkout' | 'sessions' | 'failed' | 'legacy' | 'paused';

const base: WorkspaceTask = {
  id: 1, projectId: 1, repoId: 1, name: 'Retry refund webhooks', branchName: 'leo/refund-webhooks',
  stage: 'active', state: 'preparing', archivedAt: null, updatedAt: '',
};

/** Supplied task states only: no backend, polling or Git. */
@Component({
  selector: 'ex-task-setup-demo',
  imports: [ButtonComponent, TaskListComponent, WorkspaceTaskSetupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-setup-demo.component.html',
  styleUrl: './task-setup-demo.component.css',
})
export class TaskSetupDemoComponent {
  protected readonly moments: readonly SetupMoment[] = ['queued', 'fetching', 'waiting', 'checkout', 'sessions', 'failed', 'legacy', 'paused'];
  protected readonly moment = signal<SetupMoment>('checkout');
  protected readonly task = computed<WorkspaceTask>(() => {
    const moment = this.moment();
    if (moment === 'failed') return { ...base, state: 'failed', setupStep: 'checkout', setupIssue: {
      code: 'branch-in-use', canUseSnapshot: true,
      message: 'Another task is using this branch. Use its committed revision in a separate workspace, or retry after that task finishes.',
    } };
    if (moment === 'legacy') return base;
    return { ...base, setupStep: moment === 'paused' ? 'checkout' : moment };
  });
  protected readonly tasks = computed<readonly TaskOutline[]>(() => {
    const row = (id: number, name: string, task: Partial<WorkspaceTask>, sessions: TaskOutline['sessions'] = []): TaskOutline => {
      const signal = workspaceTaskSignal({ ...base, id, name, ...task });
      // Mirrors the store: only a ready workspace accepts new sessions.
      return { id: String(id), title: name, stage: 'active', sessions, canAddSession: (task.state ?? base.state) === 'ready', ...(signal ? { workspace: signal } : {}) };
    };
    return [
      row(1, base.name, this.task()),
      row(2, 'Ledger export', { state: 'failed', setupStep: 'fetching', setupIssue: { code: 'other', canUseSnapshot: false, message: 'The workspace could not be prepared.' } }),
      row(3, 'Flaky checkout test', { state: 'finishing' }, [{ id: 's3', title: 'Investigate timeouts', status: 'done' }]),
      row(4, 'Billing dashboard', { state: 'released' }, [{ id: 's4', title: 'Chart polish', status: 'done' }]),
      row(5, 'Docs sweep', { state: 'failed', setupIssue: { code: 'other', canUseSnapshot: false, closeFailed: true, message: 'The task could not be closed.' } }),
      row(6, 'Search ranking', { state: 'ready' }, [{ id: 's6', title: 'Tune weights', status: 'running' }]),
    ];
  });
}
