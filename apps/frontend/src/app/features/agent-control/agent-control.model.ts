export type AgentControlContextKind = 'global' | 'project' | 'repo' | 'worktree' | 'session';

export interface AgentControlContext {
  kind: AgentControlContextKind;
  label: string;
  projectId?: number;
  projectName?: string;
  repoId?: number;
  repoName?: string;
  worktreePath?: string;
  workspaceName?: string | null;
  branchName?: string | null;
  sessionId?: number;
  sessionName?: string | null;
}

export const AGENT_CONTROL_GLOBAL_CONTEXT: AgentControlContext = {
  kind: 'global',
  label: 'Elevenex',
};
