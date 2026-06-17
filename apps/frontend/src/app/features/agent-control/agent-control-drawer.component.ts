import { Component, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleDashed,
  lucideClipboardList,
  lucideFolder,
  lucideGitBranch,
  lucidePlay,
  lucideRotateCcw,
  lucideSparkles,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentChannelWebsocketService } from './agent-channel-websocket.service';
import { AgentControlStateService } from './agent-control-state.service';
import { AgentAutonomyMode, AgentMission, AgentMissionStatus } from './agent-control.model';
import { AutonomySelectorComponent } from './components/autonomy-selector.component';
import {
  EscalationCardComponent,
  EscalationResolution,
} from './components/escalation-card.component';
import {
  LiveEscalationCardComponent,
  LiveEscalationResolution,
} from './components/live-escalation-card.component';
import { MissionTreeComponent } from './components/mission-tree.component';

@Component({
  selector: 'app-agent-control-drawer',
  standalone: true,
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    AutonomySelectorComponent,
    MissionTreeComponent,
    EscalationCardComponent,
    LiveEscalationCardComponent,
  ],
  templateUrl: './agent-control-drawer.component.html',
  styleUrl: './agent-control-drawer.component.scss',
  viewProviders: [
    provideIcons({
      lucideCircleDashed,
      lucideClipboardList,
      lucideFolder,
      lucideGitBranch,
      lucidePlay,
      lucideRotateCcw,
      lucideSparkles,
      lucideX,
    }),
  ],
})
export class AgentControlDrawerComponent {
  readonly state = inject(AgentControlStateService);
  readonly channelWs = inject(AgentChannelWebsocketService);

  constructor() {
    // Open the live meta-agent channel as soon as the drawer mounts; idempotent.
    this.channelWs.connect();
  }

  readonly promptDraft = signal('');
  readonly recentMissions = computed(() => this.state.missions().slice(0, 6));
  readonly hasMissions = computed(() => this.state.missions().length > 0);
  readonly canSubmit = computed(() => this.promptDraft().trim().length > 0);

  close(): void {
    this.state.close();
  }

  selectMission(id: string): void {
    this.state.selectMission(id);
  }

  setAutonomyMode(mode: AgentAutonomyMode): void {
    this.state.setAutonomyMode(mode);
  }

  setMissionAutonomyMode(missionId: string, mode: AgentAutonomyMode): void {
    this.state.setMissionAutonomyMode(missionId, mode);
  }

  createMissionFromPrompt(): void {
    const mission = this.state.createMission(this.promptDraft());
    if (mission) {
      this.promptDraft.set('');
      toast.success('Mission created', { description: mission.title });
    }
  }

  resetMissions(): void {
    this.state.reset();
    toast.info('Missions cleared');
  }

  onComposerInput(event: Event): void {
    this.promptDraft.set((event.target as HTMLTextAreaElement).value);
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      this.createMissionFromPrompt();
    }
  }

  resolveApproval(missionId: string, resolution: EscalationResolution): void {
    this.state.resolveApproval(missionId, resolution.approvalId, resolution.decision);
    if (resolution.decision === 'approve') {
      toast.success('Approved');
    } else {
      toast.error('Declined', { description: 'Mission blocked pending your direction.' });
    }
  }

  resolveLiveApproval(resolution: LiveEscalationResolution): void {
    this.channelWs.resolveApproval(resolution.approvalId, resolution.decision);
    toast.success('Decision sent', { description: resolution.decision });
  }

  openLiveDeepLink(deepLink: string): void {
    this.channelWs.openDeepLink(deepLink);
  }

  nextActionLabel(mission: AgentMission): string | null {
    switch (mission.status) {
      case 'planned':
        return 'Run mission';
      case 'running':
        return 'Move to review';
      case 'review':
        return 'Complete';
      default:
        return null;
    }
  }

  advanceMission(mission: AgentMission): void {
    switch (mission.status) {
      case 'planned':
        this.state.runMission(mission.id);
        toast.info('Mission running');
        return;
      case 'running':
        this.state.reviewMission(mission.id);
        toast.info('Mission in review');
        return;
      case 'review':
        this.state.completeMission(mission.id);
        toast.success('Mission complete');
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

  relativeTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }

    const diffMs = Date.now() - date.getTime();
    const diffSeconds = Math.round(diffMs / 1000);
    if (diffSeconds < 45) {
      return 'just now';
    }
    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }
}
