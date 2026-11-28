import { ChangeDetectionStrategy, Component, computed, effect, input, linkedSignal, output, signal } from '@angular/core';
import type { WorkspaceTask, WorkspaceTaskRecovery } from '@elevenex/shared';
import { ButtonComponent, IconComponent, ProgressLineComponent, StepListComponent } from '../ui';
import { setupElapsed, workspaceSetupSteps, workspaceTaskSignal } from './workspace-task-progress';

/** Presents one saved task's preparation and emits explicit recovery choices. */
@Component({
  selector: 'ex-workspace-task-setup',
  imports: [ButtonComponent, IconComponent, ProgressLineComponent, StepListComponent],
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
  readonly closeRequested = output<void>();

  /** A setup that is still moving; paused polling must not look alive. */
  protected readonly live = computed(() => this.task().state === 'preparing' && !this.paused() && !!this.task().setupStep);
  // Elapsed time is observed locally: remote clocks may differ from this one.
  private readonly stepKey = computed(() => `${this.task().id}/${this.task().state}/${this.task().setupStep ?? ''}`);
  private readonly stepSince = linkedSignal({ source: this.stepKey, computation: () => Date.now() });
  private readonly now = signal(Date.now());
  protected readonly steps = computed(() => {
    const live = this.live(), elapsed = live ? Math.max(0, this.now() - this.stepSince()) : 0;
    const steps = workspaceSetupSteps(this.task(), elapsed);
    return live && steps ? steps.map(step => step.state === 'active' ? { ...step, meta: setupElapsed(elapsed) } : step) : steps;
  });
  /** Announced once per step; the ticking time stays out of the live region. */
  protected readonly announcement = computed(() => workspaceTaskSignal(this.task())?.description ?? '');
  protected readonly branch = computed(() => this.task().branchName.replace(/^refs\/(heads|remotes)\//, ''));

  constructor() {
    effect(onCleanup => {
      if (!this.live()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }
}
