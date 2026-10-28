/** Renderer view models. Owners feed data and handle intents; these components never access the platform. */
export type SessionStatus =
  | 'running'
  | 'attention'
  | 'review'
  | 'done'
  | 'failed'
  | 'queued';
export type TaskStage = 'planned' | 'active' | 'waiting' | 'closed';
export type ProjectHue = 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose';
export interface ProjectMark {
  readonly name: string;
  readonly logo?: string;
  readonly initials?: string;
  readonly emoji?: string;
  readonly icon?: string;
  readonly hue?: ProjectHue;
}
export interface Project extends ProjectMark {
  readonly id: string;
  readonly attention?: number;
  readonly running?: number;
  readonly muted?: boolean;
}
export interface ProjectActivity {
  readonly attention?: number;
  readonly running?: number;
  readonly muted?: boolean;
}
export type SummaryStatus = 'attention' | 'running' | 'review' | 'done';
export type StatusCounts = Readonly<Partial<Record<SummaryStatus, number>>>;
export interface TaskLink {
  readonly kind: 'pr' | 'ticket';
  readonly label: string;
  readonly state?: string;
  readonly href?: string;
}
export interface BranchInfo {
  readonly name: string;
  readonly when?: string;
  readonly remote?: boolean;
  readonly task?: string;
  readonly isDefault?: boolean;
}
export interface BranchRow extends BranchInfo {
  readonly kind: 'create' | 'branch' | 'invalid';
}
export interface Workspace {
  readonly name: string;
  readonly state: 'free' | 'used';
  readonly note?: string;
  readonly task?: string;
}
/** Repository identity supplied by the owning project feature. */
export interface Repo {
  readonly id?: string;
  readonly name: string;
  readonly short?: string;
  readonly hue?: ProjectHue;
  readonly path?: string;
  readonly base?: string;
}
/** Stable identities are required when repositories can be picked. */
export interface TaskRepository extends Repo { readonly id: string }
export interface TaskParentContext { readonly id?: string; readonly title: string; readonly branch?: string }
export interface CreatedTask {
  readonly repo?: string;
  readonly title: string;
  readonly branch: string;
  readonly existing: boolean;
  readonly base: string | null;
  readonly workspace: string;
}
export interface PlannedTask {
  readonly repo?: string;
  readonly title: string;
  readonly branch?: string;
  readonly base?: string;
  readonly workspace: string;
}
/** Explicit earlier-session disclosure. New arrivals never displace revealed rows. */
export interface TaskSessionDisclosure {
  readonly taskId: string;
  readonly cap: number;
  readonly hiddenIds: readonly string[];
  /** Reveals, newest batch first. IDs keep selection/status updates in place. */
  readonly batches?: readonly (readonly string[])[];
}
export interface TaskSession {
  readonly id: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly kind?: 'main' | 'fork' | 'side' | 'auto';
  readonly diff?: { readonly add: number; readonly del: number };
  readonly meta?: string;
  readonly unread?: boolean;
  readonly fresh?: boolean;
}
export interface SubTask {
  readonly id: string;
  readonly title: string;
  readonly branch?: string;
  readonly parent?: string | null;
  readonly sessions?: readonly TaskSession[];
  readonly ready?: boolean;
  readonly merged?: boolean;
  readonly diff?: { readonly add: number; readonly del: number };
}
export interface TaskOutline {
  readonly id: string;
  readonly title: string;
  readonly sessions: readonly TaskSession[];
  /** Optional, independently paginated archived history supplied by the owner. */
  readonly archive?: TaskSessionArchive;
  /** The owner can advance a bounded session page without growing this outline. */
  readonly moreSessions?: boolean;
  readonly sessionsDirection?: 'earlier' | 'next';
  readonly canAddSession?: boolean;
  readonly stage?: TaskStage;
  readonly project?: ProjectMark;
  readonly links?: readonly TaskLink[];
  readonly repo?: Repo | string;
  readonly subtasks?: readonly SubTask[];
  readonly fresh?: boolean;
  readonly collapsed?: boolean;
}
export interface TaskSessionArchive {
  readonly sessions: readonly TaskSession[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly more: boolean;
  readonly earlier: boolean;
}
export interface TaskContext {
  readonly project?: ProjectMark;
  readonly title: string;
  readonly branch?: string;
  readonly base?: string;
  readonly workspace?: {
    readonly state: 'setup' | 'ready';
    readonly step?: string;
  };
}
export interface PanelTab {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly badge?: boolean;
  readonly panelId?: string;
}
export interface GitState {
  readonly files?: number;
  readonly add?: number;
  readonly del?: number;
  readonly ahead?: number;
  readonly busy?: 'commit' | 'push' | 'merge';
  readonly busyLabel?: string;
  readonly mergeInto?: string;
  readonly job?: GitJob;
}
/** Supplied job data. The owner runs the job and opens the named helper session. */
export interface GitJobStep {
  readonly id: string;
  readonly status: SessionStatus;
  readonly label: string;
  readonly detail?: string;
  readonly short?: string;
  readonly session?: { readonly id: string; readonly title: string };
}
export interface GitJob {
  readonly id: string;
  readonly verb?: string;
  readonly noun?: string;
  readonly title?: string;
  readonly steps: readonly GitJobStep[];
  readonly waiting?: boolean;
  readonly open?: boolean;
  readonly note?: string;
}
export type GitAction =
  | 'commit'
  | 'push'
  | 'commit-push'
  | 'commit-pr'
  | 'push-pr'
  | 'push-new-name'
  | 'sync'
  | 'merge'
  | 'commit-merge'
  | 'merge-commit'
  | 'rebase-parent';
export interface CloseTaskIntent {
  readonly push: boolean;
  readonly moveTicket: boolean;
}
export const TASK_STAGE_LABELS: Readonly<Record<TaskStage, string>> = {
  planned: 'Planned',
  active: 'In progress',
  waiting: 'Waiting',
  closed: 'Closed',
};
export const SUMMARY_LABELS: Readonly<Record<SummaryStatus, string>> = {
  attention: 'Needs you',
  running: 'Running',
  review: 'Review',
  done: 'Done',
};

/** Failed sessions belong in Needs you, without shuffling their original position. */
export function matchesSessionFilter(
  status: SessionStatus,
  filter: SessionStatus | null,
): boolean {
  return (
    !filter ||
    status === filter ||
    (filter === 'attention' && status === 'failed')
  );
}
