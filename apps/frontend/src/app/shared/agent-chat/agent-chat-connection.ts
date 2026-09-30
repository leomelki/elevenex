import type {
  AgentProviderId,
  AgentRuntimeCommand,
  AgentRuntimeEvent,
} from '@/shared/models/agent-runtime.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { firstValueFrom, Subscription } from 'rxjs';
import { AgentConversation } from './agent-conversation';

export interface AgentChatTarget {
  sessionId: number;
  provider: AgentProviderId;
}

/** One embedded surface's socket subscription and in-flight history refresh. */
export class AgentChatConnection {
  private active: {
    target: AgentChatTarget;
    conversation: AgentConversation;
    subscription?: Subscription;
    refresh?: Promise<void>;
  } | null = null;

  constructor(
    private readonly ws: AgentRuntimeWebsocketService,
    private readonly api: AgentRuntimeApiService,
  ) {}

  attach(
    target: AgentChatTarget,
    conversation: AgentConversation,
    onEvent?: (event: AgentRuntimeEvent) => void,
  ): void {
    this.detach();
    const active = { target, conversation } as NonNullable<typeof this.active>;
    this.active = active;
    active.subscription = this.ws.borrow(target.sessionId, target.provider).subscribe((event) => {
      if (this.active !== active) return;
      conversation.apply(event);
      onEvent?.(event);
      if (event.type === 'complete') void this.refreshHistory();
    });
    this.send({ type: 'hydrate' });
  }

  send(message: AgentRuntimeCommand): void {
    const target = this.active?.target;
    if (target) this.ws.send(target.sessionId, message, target.provider);
  }

  refreshHistory(): Promise<void> {
    const active = this.active;
    if (!active) return Promise.resolve();
    if (active.refresh) return active.refresh;
    const { target, conversation } = active;
    const refresh = (async () => {
      try {
        const history = await firstValueFrom(
          this.api.getHistory(target.sessionId, target.provider),
        );
        if (this.active === active) conversation.applyHistoryRefresh(history);
      } catch {
        if (this.active === active)
          conversation.lastError.set('Could not refresh conversation history.');
      }
    })();
    active.refresh = refresh;
    void refresh.finally(() => {
      if (active.refresh === refresh) active.refresh = undefined;
    });
    return refresh;
  }

  detach(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.subscription?.unsubscribe();
    this.ws.releaseBorrow(active.target.sessionId, active.target.provider);
  }
}
