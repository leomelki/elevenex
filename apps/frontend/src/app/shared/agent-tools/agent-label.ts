import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';

/** Turn provider task identifiers into readable titles while preserving acronyms. */
export function formatAgentTask(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function agentReferenceLabel(reference: string): string {
  if (reference === '/root' || reference === 'root') return 'Main agent';
  if (/^[\da-f]{8}-[\da-f-]+$/i.test(reference)) return `Agent ${reference.slice(0, 8)}`;
  return formatAgentTask(reference.split('/').filter(Boolean).at(-1) ?? reference);
}

export function agentLabel(
  agent: Pick<AgentSubagentState, 'agentType' | 'displayName' | 'agentPath'>,
): string {
  return agent.agentPath?.trim()
    ? agentReferenceLabel(agent.agentPath)
    : formatAgentTask(agent.agentType) || agent.displayName || 'Agent';
}
