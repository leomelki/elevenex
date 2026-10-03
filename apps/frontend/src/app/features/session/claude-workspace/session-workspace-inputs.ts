import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type { Signal } from '@angular/core';

export type SessionWorkspaceEvent =
  | {
      type:
        | 'reset'
        | 'restore-draft'
        | 'load-context'
        | 'context-generation'
        | 'load-actions'
        | 'focus-composer'
        | 'prompt-submitted'
        | 'runtime-error'
        | 'complete';
    }
  | { type: 'session-change'; previousSessionId: number };
export interface SessionWorkspaceInputs {
  readonly sessionId: Signal<number>;
  readonly repoId: Signal<number>;
  readonly worktreePath: Signal<string>;
  readonly hasInjectedWorktreeContext: Signal<boolean>;
  readonly activeAgentProvider: Signal<AgentProviderId>;
  readonly hasStartedAgentRuntime: Signal<boolean>;
  readonly isVisible: Signal<boolean>;
  readonly archived: Signal<boolean>;
  readonly readOnlyTranscript: Signal<boolean>;
  readonly terminalTranscriptMirror: Signal<boolean>;
}
