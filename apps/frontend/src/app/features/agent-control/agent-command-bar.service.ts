import { Injectable, signal } from '@angular/core';

/**
 * Open/close state for the global Cmd/Ctrl+K agent command bar — the modern,
 * centered search surface used to ask the Elevenex agent a question from
 * anywhere in the app. Submitting it creates a mission via
 * {@link AgentControlStateService.createMission}, which opens the agent drawer
 * and starts the agent on the typed prompt.
 */
@Injectable({ providedIn: 'root' })
export class AgentCommandBarService {
  private readonly openSignal = signal(false);
  readonly isOpen = this.openSignal.asReadonly();

  open(): void {
    this.openSignal.set(true);
  }

  close(): void {
    this.openSignal.set(false);
  }

  toggle(): void {
    this.openSignal.update((value) => !value);
  }
}
