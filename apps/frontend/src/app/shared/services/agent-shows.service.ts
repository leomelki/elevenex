import { Injectable, signal } from '@angular/core';
import type { AgentShow } from '@/shared/models/agent-channel.model';

/**
 * Shared store for live "show_user" cards pushed by the meta-agent.
 * Populated by AgentChannelWebsocketService; consumed by ClaudeWorkspaceComponent
 * to render inline cards at the end of the chat for the relevant session.
 */
@Injectable({ providedIn: 'root' })
export class AgentShowsService {
  private readonly showsSignal = signal<AgentShow[]>([]);
  readonly liveShows = this.showsSignal.asReadonly();

  push(show: AgentShow): void {
    this.showsSignal.update((shows) => {
      const deduped = shows.filter((s) => s.id !== show.id);
      return [...deduped, show];
    });
  }

  dismiss(id: string): void {
    this.showsSignal.update((shows) => shows.filter((s) => s.id !== id));
  }

  forSession(sessionId: number): AgentShow[] {
    return this.showsSignal().filter((s) => s.agentSessionId === sessionId);
  }
}
