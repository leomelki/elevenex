import type { AgentProviderId } from '../agent-runtime/agent-runtime.types.js';

export interface SessionProviderColumns {
  readonly activeAgentProvider?: string | null;
  readonly claudeSessionId?: string | null;
  readonly codexSessionId?: string | null;
  readonly piSessionPath?: string | null;
  readonly opencodeSessionId?: string | null;
  readonly antigravitySessionId?: string | null;
}

const providerColumns = [
  ['antigravity', 'antigravitySessionId'],
  ['opencode', 'opencodeSessionId'],
  ['pi', 'piSessionPath'],
  ['codex', 'codexSessionId'],
  ['claude', 'claudeSessionId'],
] as const;

export function hasStartedAgentConversation(
  session: SessionProviderColumns,
): boolean {
  return providerColumns.some(([, column]) => {
    const id = session[column]?.trim();
    return !!id && id !== '-1';
  });
}

/** Legacy rows can retain the default Claude choice after starting another harness. */
export function sessionAgentProvider(
  session: SessionProviderColumns,
): AgentProviderId {
  const started = providerColumns.filter(([, column]) => {
    const id = session[column]?.trim();
    return !!id && id !== '-1';
  });
  const persisted = session.activeAgentProvider?.trim();
  const staleDefault =
    persisted === 'claude' &&
    started.length > 0 &&
    !started.some(([provider]) => provider === 'claude');
  return persisted && !staleDefault ? persisted : (started[0]?.[0] ?? 'claude');
}
