import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideCircleDashed,
  lucideHistory,
  lucideListChecks,
  lucidePlus,
  lucideSparkles,
  lucideSquare,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentChannelWebsocketService } from './agent-channel-websocket.service';
import { AgentControlStateService } from './agent-control-state.service';
import {
  AgentAutonomyMode,
  MissionStatusView,
  MissionSummary,
  missionStatusView,
} from './agent-control.model';
import { AutonomySelectorComponent } from './components/autonomy-selector.component';
import {
  LiveEscalationCardComponent,
  LiveEscalationResolution,
} from './components/live-escalation-card.component';
import { MissionTreeComponent } from './components/mission-tree.component';
import { MissionConversationComponent } from './components/mission-conversation/mission-conversation.component';

@Component({
  selector: 'app-agent-control-drawer',
  standalone: true,
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    AutonomySelectorComponent,
    MissionTreeComponent,
    MissionConversationComponent,
    LiveEscalationCardComponent,
  ],
  templateUrl: './agent-control-drawer.component.html',
  styleUrl: './agent-control-drawer.component.scss',
  viewProviders: [
    provideIcons({
      lucideArchive,
      lucideCircleDashed,
      lucideHistory,
      lucideListChecks,
      lucidePlus,
      lucideSparkles,
      lucideSquare,
      lucideTrash2,
      lucideX,
    }),
  ],
})
export class AgentControlDrawerComponent {
  readonly state = inject(AgentControlStateService);
  readonly channelWs = inject(AgentChannelWebsocketService);

  /** Draft text for the NEW-mission composer. */
  readonly promptDraft = signal('');
  /** When true, show the new-mission composer. Defaults to true so every open starts fresh. */
  private readonly composingSignal = signal(true);
  /** When true, show the history overlay panel. */
  private readonly showHistorySignal = signal(false);

  readonly composing = computed(() => this.composingSignal());
  readonly showHistory = computed(() => this.showHistorySignal());
  readonly canSubmit = computed(() => this.promptDraft().trim().length > 0);

  constructor() {
    // Open the live meta-agent channel as soon as the drawer mounts; idempotent.
    this.channelWs.connect();
    // On every open: reset to fresh composer state, clear any previous selection.
    let wasOpen = false;
    effect(() => {
      const open = this.state.isOpen();
      if (open && !wasOpen) {
        this.composingSignal.set(true);
        this.showHistorySignal.set(false);
        this.state.clearSelection();
        void this.state.refresh();
      }
      wasOpen = open;
    });
  }

  /**
   * Escape closes the drawer while it is open. The Cmd/Ctrl+K shortcut is owned
   * by the agent command bar (see `AgentCommandBarComponent`), which opens the
   * centered "ask the agent" search surface; submitting it opens this drawer.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.state.isOpen()) {
      event.preventDefault();
      this.close();
    }
  }

  close(): void {
    this.state.close();
  }

  selectMission(sessionId: number): void {
    this.composingSignal.set(false);
    this.state.selectMission(sessionId);
  }

  startNewMission(): void {
    this.composingSignal.set(true);
  }

  cancelNewMission(): void {
    this.composingSignal.set(false);
    this.promptDraft.set('');
  }

  openHistory(): void {
    this.showHistorySignal.set(true);
  }

  closeHistory(): void {
    this.showHistorySignal.set(false);
  }

  selectFromHistory(sessionId: number): void {
    this.showHistorySignal.set(false);
    this.composingSignal.set(false);
    this.state.selectMission(sessionId);
  }

  setDraftAutonomy(mode: AgentAutonomyMode): void {
    this.state.setDraftAutonomy(mode);
  }

  async submitNewMission(): Promise<void> {
    if (!this.canSubmit()) {
      return;
    }
    const sessionId = await this.state.createMission(this.promptDraft());
    if (sessionId != null) {
      this.promptDraft.set('');
      this.composingSignal.set(false);
      toast.success('Mission started');
    } else {
      toast.error('Could not start the mission');
    }
  }

  async setMissionAutonomy(
    sessionId: number,
    mode: AgentAutonomyMode,
  ): Promise<void> {
    await this.state.setMissionAutonomy(sessionId, mode);
  }

  async interrupt(sessionId: number): Promise<void> {
    await this.state.interruptMission(sessionId);
    toast.info('Interrupt sent');
  }

  async archive(sessionId: number): Promise<void> {
    await this.state.archiveMission(sessionId);
    toast.info('Mission archived');
  }

  resolveLiveApproval(resolution: LiveEscalationResolution): void {
    this.channelWs.resolveApproval(resolution.approvalId, resolution.decision);
    toast.success('Decision sent', { description: resolution.decision });
  }

  openLiveDeepLink(deepLink: string): void {
    this.channelWs.openDeepLink(deepLink);
  }

  onComposerInput(event: Event): void {
    this.promptDraft.set((event.target as HTMLTextAreaElement).value);
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.submitNewMission();
    }
  }

  statusView(mission: MissionSummary): MissionStatusView {
    return missionStatusView(mission);
  }

  statusLabel(view: MissionStatusView): string {
    switch (view) {
      case 'waiting_approval':
        return 'Needs you';
      case 'running':
        return 'Running';
      case 'complete':
        return 'Archived';
      case 'error':
        return 'Error';
      case 'idle':
        return 'Idle';
    }
  }

  /** Whether interrupting makes sense (the agent is actively running). */
  canInterrupt(mission: MissionSummary): boolean {
    return mission.runPhase === 'running' || mission.runPhase === 'waiting';
  }

  relativeTime(value: string | null): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000);
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
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }
}
