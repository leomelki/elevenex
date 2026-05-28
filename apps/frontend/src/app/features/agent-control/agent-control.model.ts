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

export type AgentMissionStatus =
  | 'draft'
  | 'planned'
  | 'waiting_approval'
  | 'running'
  | 'review'
  | 'complete'
  | 'blocked';

export type AgentMissionStepStatus = 'pending' | 'active' | 'complete' | 'blocked';

export interface AgentMissionStep {
  id: string;
  kind: 'project' | 'repo' | 'worktree' | 'agent' | 'review' | 'action';
  label: string;
  status: AgentMissionStepStatus;
  targetSummary: string;
  previewPayload?: Record<string, unknown>;
}

export interface AgentMissionApproval {
  id: string;
  label: string;
  status: 'pending' | 'approved' | 'skipped';
  summary: string;
}

export interface AgentMissionArtifact {
  id: string;
  kind: 'plan' | 'command' | 'diff' | 'transcript' | 'review';
  label: string;
  summary: string;
}

export interface AgentMissionMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string;
}

export interface AgentMission {
  id: string;
  title: string;
  prompt: string;
  status: AgentMissionStatus;
  context: AgentControlContext;
  steps: AgentMissionStep[];
  approvals: AgentMissionApproval[];
  artifacts: AgentMissionArtifact[];
  messages: AgentMissionMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentMissionTemplate {
  id: 'create_project' | 'create_worktree' | 'run_agent' | 'review_work';
  label: string;
  description: string;
  icon: string;
  prompt: string;
}

export const AGENT_CONTROL_GLOBAL_CONTEXT: AgentControlContext = {
  kind: 'global',
  label: 'Elevenex',
};
