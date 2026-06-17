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

export type AgentMissionKind = 'create_project' | 'create_worktree' | 'run_agent' | 'review_work';

export type AgentMissionStepStatus = 'pending' | 'active' | 'complete' | 'blocked';

/**
 * Autonomy modes describe how much the meta-agent may do without a human in the loop.
 * - full: act autonomously end-to-end, no approval gates.
 * - review: act autonomously but pause for approval before destructive actions.
 * - plan: produce a plan first and wait for explicit approval before any action.
 */
export type AgentAutonomyMode = 'full' | 'review' | 'plan';

/** A resolved deep-link target carried by a step or approval. */
export interface AgentDeepLinkTarget {
  /** A session to open in the workspace (router → /sessions/:id). */
  sessionId?: number;
  /** A project to reveal in the navigation tree. */
  projectId?: number;
}

export interface AgentMissionStep {
  id: string;
  kind: 'project' | 'repo' | 'worktree' | 'agent' | 'review' | 'action';
  label: string;
  status: AgentMissionStepStatus;
  targetSummary: string;
  /** Optional deep-link target so the user can jump to the exact view for this step. */
  target?: AgentDeepLinkTarget;
  previewPayload?: Record<string, unknown>;
}

export interface AgentMissionApproval {
  id: string;
  label: string;
  status: 'pending' | 'approved' | 'skipped';
  summary: string;
  /** Optional deep-link target so the user can review the exact view before deciding. */
  target?: AgentDeepLinkTarget;
}

export type AgentApprovalDecision = 'approve' | 'decline';

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
  /** The autonomy mode this mission was created with. */
  autonomyMode: AgentAutonomyMode;
  context: AgentControlContext;
  steps: AgentMissionStep[];
  approvals: AgentMissionApproval[];
  artifacts: AgentMissionArtifact[];
  messages: AgentMissionMessage[];
  createdAt: string;
  updatedAt: string;
}

export const AGENT_CONTROL_GLOBAL_CONTEXT: AgentControlContext = {
  kind: 'global',
  label: 'Elevenex',
};

export interface AgentAutonomyModeDescriptor {
  id: AgentAutonomyMode;
  label: string;
  description: string;
  /** Lucide icon name registered in the selector component. */
  icon: string;
}

export const AGENT_AUTONOMY_MODES: readonly AgentAutonomyModeDescriptor[] = [
  {
    id: 'full',
    label: 'Full',
    description: 'Act autonomously end-to-end.',
    icon: 'lucideZap',
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Pause before destructive actions.',
    icon: 'lucideShieldCheck',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Plan first, then ask to proceed.',
    icon: 'lucideListChecks',
  },
] as const;

export const DEFAULT_AGENT_AUTONOMY_MODE: AgentAutonomyMode = 'review';
