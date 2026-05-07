import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ClaudeRuntimeEvent } from '../models/claude-runtime.model';
import { AgentRuntimeWebsocketService } from './agent-runtime-websocket.service';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeWebsocketService {
  private readonly agentRuntimeWs = inject(AgentRuntimeWebsocketService);

  connect(sessionId: number): Observable<ClaudeRuntimeEvent> {
    return this.agentRuntimeWs.connect(sessionId, 'claude');
  }

  send(sessionId: number, message: Record<string, unknown>): void {
    this.agentRuntimeWs.send(sessionId, message, 'claude');
  }

  disconnect(sessionId: number): void {
    this.agentRuntimeWs.disconnect(sessionId, 'claude');
  }
}
