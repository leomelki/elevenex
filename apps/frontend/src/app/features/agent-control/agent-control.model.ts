/**
 * Autonomy modes describe how much the meta-agent may do without a human in the loop.
 * - full: act autonomously end-to-end, no approval gates.
 * - review: act autonomously but pause for approval before destructive actions.
 * - plan: produce a plan first and wait for explicit approval before any action.
 *
 * These mirror the backend `AgentAutonomyMode` (sessions.service.ts).
 */
export type AgentAutonomyMode = 'full' | 'review' | 'plan';

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

/** A resolved deep-link target carried by a mission step. */
export interface AgentDeepLinkTarget {
  /** A session to open in the workspace (router → /sessions/:id). */
  sessionId?: number;
  /** A project to reveal in the navigation tree. */
  projectId?: number;
}

export type AgentMissionStepStatus = 'pending' | 'active' | 'complete' | 'blocked';

/**
 * One node in the selected mission's step tree. Derived from the agent's real
 * TodoWrite plan (todo → step), not invented.
 */
export interface AgentMissionStep {
  id: string;
  kind: 'project' | 'repo' | 'worktree' | 'agent' | 'review' | 'action';
  label: string;
  status: AgentMissionStepStatus;
  targetSummary: string;
  target?: AgentDeepLinkTarget;
}

/**
 * A mission summary as returned by `GET /api/agent/missions`. A mission IS a
 * hidden `surface:'agent'` session driven by the meta-agent runtime.
 */
export interface MissionSummary {
  sessionId: number;
  title: string;
  /** Persisted session status: created | active | stopped | archived. */
  status: string;
  /** Live run phase from the runtime: idle | running | waiting | error | null. */
  runPhase: string | null;
  /** True when the agent is blocked on a permission/user-input prompt. */
  awaitingApproval: boolean;
  autonomyMode: AgentAutonomyMode;
  repoId: number;
  worktreePath: string;
  deepLink: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A coarse, panel-facing status used to drive the mission row's pill. */
export type MissionStatusView =
  | 'running'
  | 'waiting_approval'
  | 'complete'
  | 'error'
  | 'idle';

/**
 * Collapse a mission's persisted status + live run phase into a single coarse
 * view for the row pill.
 */
export function missionStatusView(mission: MissionSummary): MissionStatusView {
  if (mission.awaitingApproval) {
    return 'waiting_approval';
  }
  if (mission.runPhase === 'error') {
    return 'error';
  }
  if (mission.runPhase === 'running' || mission.runPhase === 'waiting') {
    return 'running';
  }
  if (mission.status === 'archived') {
    return 'complete';
  }
  return 'idle';
}
