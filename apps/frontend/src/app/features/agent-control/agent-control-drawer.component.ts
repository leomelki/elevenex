import { CommonModule } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideRefreshCw,
  lucideSparkles,
  lucideTerminal,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { NavigationService } from '@/shared/services/navigation.service';
import { Session } from '@/shared/models/session.model';
import { AgentControlStateService } from './agent-control-state.service';
import {
  AgentWorkspace,
  ElevenexAgentService,
} from './elevenex-agent.service';

@Component({
  selector: 'app-agent-control-drawer',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  templateUrl: './agent-control-drawer.component.html',
  styleUrl: './agent-control-drawer.component.scss',
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
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
  private readonly navigation = inject(NavigationService);

  readonly nameDraft = signal('');
  readonly workspace = signal<AgentWorkspace | null>(null);
  readonly sessions = signal<Session[]>([]);
  readonly loading = signal(false);
  readonly creating = signal(false);

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
    const name = this.nameDraft().trim() || undefined;
    this.agentService.createSession(name).subscribe({
      next: (session) => {
        this.creating.set(false);
        this.nameDraft.set('');
        this.sessions.update((current) =>
          this.sortSessions([session, ...current]),
        );
        this.openSession(session.id);
      },
      error: (err) => {
        this.creating.set(false);
        toast.error(
          `Could not start an agent session. ${this.messageFrom(err)}`,
        );
      },
    });
  }

  openSession(sessionId: number): void {
    this.navigation.openSession(sessionId);
    this.state.close();
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      this.startSession();
    }
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
