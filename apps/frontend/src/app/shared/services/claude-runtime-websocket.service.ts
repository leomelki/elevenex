import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ClaudeRuntimeEvent } from '../models/claude-runtime.model';
import type { AgentProviderId } from '../models/agent-runtime.model';
import {
  AgentConnectionPhase,
  AgentRuntimeWebsocketService,
} from './agent-runtime-websocket.service';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeWebsocketService {
  private readonly agentRuntimeWs = inject(AgentRuntimeWebsocketService);
  private readonly providerSelection = inject(AgentRuntimeProviderService);
  private readonly sessionProviders = new Map<number, AgentProviderId>();

  setProvider(sessionId: number, provider: AgentProviderId): void {
    this.sessionProviders.set(sessionId, provider);
  }

  clearProvider(sessionId: number): void {
    this.sessionProviders.delete(sessionId);
  }

  connect(sessionId: number): Observable<ClaudeRuntimeEvent> {
    return this.agentRuntimeWs.connect(
      sessionId,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeEvent>;
  }

  send(sessionId: number, message: Record<string, unknown>): void {
    this.agentRuntimeWs.send(sessionId, message, this.provider(sessionId));
  }

  isConnected(sessionId: number): boolean {
    return this.agentRuntimeWs.isConnected(sessionId, this.provider(sessionId));
  }

  disconnect(sessionId: number): void {
    this.agentRuntimeWs.disconnect(sessionId, this.provider(sessionId));
  }

  connectionState$(sessionId: number): Observable<AgentConnectionPhase> {
    return this.agentRuntimeWs.connectionState$(sessionId, this.provider(sessionId));
  }

  private provider(sessionId: number): AgentProviderId {
    return this.sessionProviders.get(sessionId) ?? this.providerSelection.currentProvider;
  }
}
