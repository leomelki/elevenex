export type ActionStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped';

export interface Action {
  id: number;
  worktreePath: string;
  name: string;
  command: string;
  status: ActionStatus;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastExitCode: number | null;
  currentOutput: string;
  lastOutput: string;
  createdAt: string;
  updatedAt: string;
}
