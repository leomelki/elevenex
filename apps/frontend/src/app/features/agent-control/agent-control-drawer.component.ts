import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucidePlus,
  lucideRefreshCw,
  lucideSparkles,
  lucideTerminal,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { Session } from '@/shared/models/session.model';
import { AgentChatComponent } from './agent-chat/agent-chat.component';
import { AgentControlStateService } from './agent-control-state.service';
import {
  AgentWorkspace,
  ElevenexAgentService,
} from './elevenex-agent.service';

@Component({
  selector: 'app-agent-control-drawer',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardButtonComponent, AgentChatComponent],
  templateUrl: './agent-control-drawer.component.html',
  styleUrl: './agent-control-drawer.component.scss',
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucidePlus,
      lucideRefreshCw,
      lucideSparkles,
      lucideTerminal,
      lucideX,
    }),
  ],
})
export class AgentControlDrawerComponent {
  readonly state = inject(AgentControlStateService);
  private readonly agentService = inject(ElevenexAgentService);

  readonly workspace = signal<AgentWorkspace | null>(null);
  readonly sessions = signal<Session[]>([]);
  readonly activeSessionId = signal<number | null>(null);
  readonly loading = signal(false);
  readonly creating = signal(false);

  readonly activeSession = computed(
    () =>
      this.sessions().find((s) => s.id === this.activeSessionId()) ?? null,
  );

  constructor() {
    // Load the agent workspace + sessions whenever the drawer opens.
    effect(() => {
      if (this.state.isOpen()) {
        this.load();
      }
    });
  }

  close(): void {
    this.state.close();
  }

  load(): void {
    if (this.loading()) {
      return;
    }
    this.loading.set(true);
    this.agentService.getOverview().subscribe({
      next: (overview) => {
        this.workspace.set(overview.workspace);
        this.sessions.set(this.sortSessions(overview.sessions));
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        toast.error(
          `Could not load the agent workspace. ${this.messageFrom(err)}`,
        );
      },
    });
  }

  startSession(): void {
    if (this.creating()) {
      return;
    }
    this.creating.set(true);
    this.agentService.createSession().subscribe({
      next: (session) => {
        this.creating.set(false);
        this.sessions.update((current) =>
          this.sortSessions([session, ...current]),
        );
        this.openChat(session.id);
      },
      error: (err) => {
        this.creating.set(false);
        toast.error(
          `Could not start an agent session. ${this.messageFrom(err)}`,
        );
      },
    });
  }

  openChat(sessionId: number): void {
    this.activeSessionId.set(sessionId);
  }

  backToList(): void {
    this.activeSessionId.set(null);
    this.load();
  }

  statusLabel(status: Session['status']): string {
    switch (status) {
      case 'active':
        return 'Running';
      case 'created':
        return 'Ready';
      case 'stopped':
        return 'Stopped';
      case 'archived':
        return 'Archived';
      default:
        return status;
    }
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

  sessionTitle(session: Session): string {
    return session.name || `Session ${session.id}`;
  }

  private sortSessions(sessions: Session[]): Session[] {
    return [...sessions]
      .filter((session) => session.status !== 'archived')
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
  }

  private messageFrom(err: unknown): string {
    const maybe = err as { error?: { message?: string }; message?: string };
    return maybe?.error?.message || maybe?.message || 'Unknown error.';
  }
}
