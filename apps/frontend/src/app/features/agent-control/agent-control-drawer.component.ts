import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCircleDashed,
  lucideClipboardList,
  lucideFileText,
  lucideFolder,
  lucideGitBranch,
  lucidePlay,
  lucideSparkles,
  lucideX,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentControlStateService } from './agent-control-state.service';
import {
  AgentMission,
  AgentMissionStatus,
  AgentMissionStep,
} from './agent-control.model';

@Component({
  selector: 'app-agent-control-drawer',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  templateUrl: './agent-control-drawer.component.html',
  styleUrl: './agent-control-drawer.component.scss',
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCircleDashed,
      lucideClipboardList,
      lucideFileText,
      lucideFolder,
      lucideGitBranch,
      lucidePlay,
      lucideSparkles,
      lucideX,
    }),
  ],
})
export class AgentControlDrawerComponent {
  readonly state = inject(AgentControlStateService);

  readonly promptDraft = signal('');
  readonly recentMissions = computed(() => this.state.missions().slice(0, 5));

  close(): void {
    this.state.close();
  }

  selectMission(id: string): void {
    this.state.selectMission(id);
  }

  createMissionFromPrompt(): void {
    const mission = this.state.createMission(this.promptDraft());
    if (mission) {
      this.promptDraft.set('');
    }
  }

  resetMissions(): void {
    this.state.reset();
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      this.createMissionFromPrompt();
    }
  }

  nextActionLabel(mission: AgentMission): string | null {
    switch (mission.status) {
      case 'waiting_approval':
        return 'Approve preview';
      case 'planned':
        return 'Run preview';
      case 'running':
        return 'Review preview';
      case 'review':
        return 'Complete preview';
      default:
        return null;
    }
  }

  advanceMission(mission: AgentMission): void {
    switch (mission.status) {
      case 'waiting_approval':
        this.state.approveMission(mission.id);
        return;
      case 'planned':
        this.state.runMission(mission.id);
        return;
      case 'running':
        this.state.reviewMission(mission.id);
        return;
      case 'review':
        this.state.completeMission(mission.id);
        return;
      default:
        return;
    }
  }

  statusLabel(status: AgentMissionStatus): string {
    switch (status) {
      case 'waiting_approval':
        return 'Waiting approval';
      case 'planned':
        return 'Planned';
      case 'running':
        return 'Running';
      case 'review':
        return 'Review';
      case 'complete':
        return 'Complete';
      case 'blocked':
        return 'Blocked';
      case 'draft':
        return 'Draft';
    }
  }

  stepIcon(step: AgentMissionStep): string {
    if (step.status === 'complete') {
      return 'lucideCheck';
    }
    if (step.status === 'active') {
      return 'lucidePlay';
    }
    if (step.kind === 'project') {
      return 'lucideFolder';
    }
    if (step.kind === 'repo' || step.kind === 'worktree') {
      return 'lucideGitBranch';
    }
    if (step.kind === 'review') {
      return 'lucideClipboardList';
    }
    if (step.kind === 'agent') {
      return 'lucideSparkles';
    }
    return 'lucideCircleDashed';
  }

  formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

}
