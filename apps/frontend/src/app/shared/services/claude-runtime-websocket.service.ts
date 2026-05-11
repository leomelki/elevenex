import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ClaudeRuntimeEvent } from '../models/claude-runtime.model';
import { AgentConnectionPhase, AgentRuntimeWebsocketService } from './agent-runtime-websocket.service';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeWebsocketService {
  private readonly agentRuntimeWs = inject(AgentRuntimeWebsocketService);
  private readonly providerSelection = inject(AgentRuntimeProviderService);

  connect(sessionId: number): Observable<ClaudeRuntimeEvent> {
    return this.agentRuntimeWs.connect(
      sessionId,
      this.providerSelection.currentProvider,
    ) as Observable<ClaudeRuntimeEvent>;
  }

  send(sessionId: number, message: Record<string, unknown>): void {
    this.agentRuntimeWs.send(
      sessionId,
      message,
      this.providerSelection.currentProvider,
    );
  }

  isConnected(sessionId: number): boolean {
    return this.agentRuntimeWs.isConnected(
      sessionId,
      this.providerSelection.currentProvider,
    );
  }

  disconnect(sessionId: number): void {
    this.agentRuntimeWs.disconnectSession(sessionId);
  }

  connectionState$(sessionId: number): Observable<AgentConnectionPhase> {
    return this.agentRuntimeWs.connectionState$(sessionId, this.providerSelection.currentProvider);
  }
}
