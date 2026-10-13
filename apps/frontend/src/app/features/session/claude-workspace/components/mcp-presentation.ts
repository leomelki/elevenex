import type { AgentMcpServerEntry } from '@/shared/models/agent-runtime.model';

export const MCP_SCOPE_LABELS: Record<AgentMcpServerEntry['scope'], string> = {
  project: 'Project',
  local: 'This worktree',
  user: 'All projects',
  enterprise: 'Managed',
  runtime: 'Agent provided',
};

export function mcpStatus(server: AgentMcpServerEntry, provider: string) {
  if (server.shadowed) return { label: 'Overridden', tone: 'muted' };
  if (server.configStatus === 'error') return { label: 'Invalid configuration', tone: 'error' };
  if (!server.enabled || server.connectionStatus === 'disabled')
    return { label: 'Disabled', tone: 'muted' };
  switch (server.connectionStatus) {
    case 'connected':
      return { label: 'Connected', tone: 'success' };
    case 'failed':
      return { label: 'Connection failed', tone: 'error' };
    case 'needs-auth':
      return {
        label: provider === 'pi' ? 'Credentials needed' : 'Sign in needed',
        tone: 'warning',
      };
    default:
      return { label: 'Not checked', tone: 'muted' };
  }
}

export function mcpNeedsAttention(server: AgentMcpServerEntry): boolean {
  return (
    !server.shadowed &&
    (server.configStatus === 'error' ||
      (server.enabled && ['failed', 'needs-auth'].includes(server.connectionStatus)))
  );
}
