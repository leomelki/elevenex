import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ClaudeRuntimeEvent } from '../models/claude-runtime.model';
import { AgentRuntimeWebsocketService } from './agent-runtime-websocket.service';
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

  disconnect(sessionId: number): void {
    this.agentRuntimeWs.disconnect(
      sessionId,
      this.providerSelection.currentProvider,
    );
  }
}
