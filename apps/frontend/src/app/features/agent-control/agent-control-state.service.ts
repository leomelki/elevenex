import { Injectable, signal } from '@angular/core';
import {
  AGENT_CONTROL_GLOBAL_CONTEXT,
  AgentControlContext,
} from './agent-control.model';

/**
 * Open/close state for the Elevenex agent drawer. The agent always operates on
 * its own global workspace, so any contextual entry point (project, session,
 * etc.) simply opens the global panel.
 */
@Injectable({ providedIn: 'root' })
export class AgentControlStateService {
  private readonly openSignal = signal(false);
  private readonly contextSignal = signal<AgentControlContext>(
    AGENT_CONTROL_GLOBAL_CONTEXT,
  );

  readonly isOpen = this.openSignal.asReadonly();
  readonly context = this.contextSignal.asReadonly();

  open(): void {
    this.contextSignal.set(AGENT_CONTROL_GLOBAL_CONTEXT);
    this.openSignal.set(true);
  }

  openGlobal(): void {
    this.open();
  }

  openProject(_project: { id: number; name: string }): void {
    this.open();
  }

  openSession(_context: {
    projectId: number;
    repoId: number;
    sessionId: number;
    sessionName: string;
    worktreePath: string;
    workspaceName?: string | null;
    branchName: string;
  }): void {
    this.open();
  }

  toggle(): void {
    this.openSignal.update((value) => !value);
  }

  close(): void {
    this.openSignal.set(false);
  }
}
