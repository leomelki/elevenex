import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { NavigationService } from '@/shared/services/navigation.service';
import { AgentMissionStep } from '../agent-control.model';
import { StepRowComponent } from './step-row.component';

/**
 * Vertical step tree for the selected mission. Renders one StepRow per step on a
 * connected rail and resolves deep links to the right workspace view.
 */
@Component({
  selector: 'app-mission-tree',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StepRowComponent],
  templateUrl: './mission-tree.component.html',
  styleUrl: './mission-tree.component.scss',
})
export class MissionTreeComponent {
  private readonly navigation = inject(NavigationService);

  readonly steps = input.required<AgentMissionStep[]>();

  protected openStep(step: AgentMissionStep): void {
    this.openTarget(step);
  }

  /** Resolve a deep-link target: session takes priority, then project reveal. */
  private openTarget(step: AgentMissionStep): void {
    const target = step.target;
    if (!target) {
      return;
    }
    if (target.sessionId != null) {
      this.navigation.openSession(target.sessionId);
      return;
    }
    if (target.projectId != null) {
      this.navigation.revealProject(target.projectId);
    }
  }
}
