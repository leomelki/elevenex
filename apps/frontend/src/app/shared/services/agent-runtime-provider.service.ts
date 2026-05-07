import { Injectable, signal } from '@angular/core';
import type { AgentProviderId } from '../models/agent-runtime.model';

@Injectable({ providedIn: 'root' })
export class AgentRuntimeProviderService {
  readonly selectedProvider = signal<AgentProviderId>('claude');

  get currentProvider(): AgentProviderId {
    return this.selectedProvider();
  }

  setProvider(provider: AgentProviderId): void {
    this.selectedProvider.set(provider);
  }
}
