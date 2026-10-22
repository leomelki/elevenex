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
export interface CreatedTask {
  readonly title: string;
  readonly branch: string;
  readonly existing: boolean;
  readonly base: string | null;
  readonly workspace: string;
}
export interface PlannedTask {
  readonly title: string;
  readonly branch?: string;
  readonly base?: string;
  readonly workspace: string;
}
export interface TaskSession {
  readonly id: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly kind?: 'main' | 'fork' | 'side';
  readonly diff?: { readonly add: number; readonly del: number };
  readonly meta?: string;
  readonly unread?: boolean;
  readonly fresh?: boolean;
}
export interface TaskOutline {
  readonly id: string;
  readonly title: string;
  readonly sessions: readonly TaskSession[];
  readonly stage?: TaskStage;
  readonly project?: ProjectMark;
  readonly links?: readonly TaskLink[];
  readonly repo?: string;
  readonly fresh?: boolean;
  readonly collapsed?: boolean;
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
  readonly busy?: 'commit' | 'push';
}
export type GitAction =
  | 'commit'
  | 'push'
  | 'commit-push'
  | 'commit-pr'
  | 'push-pr'
  | 'push-new-name'
  | 'sync';
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
