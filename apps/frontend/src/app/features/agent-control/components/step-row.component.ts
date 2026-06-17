import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideCheck,
  lucideCircleDashed,
  lucideClipboardList,
  lucideFolder,
  lucideGitBranch,
  lucideLoaderCircle,
  lucidePlay,
  lucideSparkles,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { AgentMissionStep } from '../agent-control.model';

/**
 * A single row in the mission step tree: kind icon on a vertical rail, label,
 * target summary, status pill, and an optional deep-link "Open" affordance.
 * The whole row is keyboard-activatable when it carries a deep-link target.
 */
@Component({
  selector: 'app-step-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ZardButtonComponent],
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideCheck,
      lucideCircleDashed,
      lucideClipboardList,
      lucideFolder,
      lucideGitBranch,
      lucideLoaderCircle,
      lucidePlay,
      lucideSparkles,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './step-row.component.html',
  styleUrl: './step-row.component.scss',
})
export class StepRowComponent {
  readonly step = input.required<AgentMissionStep>();
  /** Whether this is the last row, so the rail can be trimmed. */
  readonly last = input(false);
  readonly open = output<AgentMissionStep>();

  protected readonly hasTarget = computed(() => {
    const target = this.step().target;
    return Boolean(target && (target.sessionId != null || target.projectId != null));
  });

  protected readonly kindIcon = computed(() => {
    switch (this.step().kind) {
      case 'project':
        return 'lucideFolder';
      case 'repo':
      case 'worktree':
        return 'lucideGitBranch';
      case 'agent':
        return 'lucideSparkles';
      case 'review':
        return 'lucideClipboardList';
      case 'action':
        return 'lucidePlay';
      default:
        return 'lucideCircleDashed';
    }
  });

  protected readonly statusLabel = computed(() => {
    switch (this.step().status) {
      case 'active':
        return 'Active';
      case 'complete':
        return 'Done';
      case 'blocked':
        return 'Blocked';
      default:
        return 'Pending';
    }
  });

  protected activate(): void {
    if (this.hasTarget()) {
      this.open.emit(this.step());
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!this.hasTarget()) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.activate();
    }
  }

  protected onOpenClick(event: MouseEvent): void {
    event.stopPropagation();
    this.open.emit(this.step());
  }
}
