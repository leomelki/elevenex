import type { WorkspaceTask, WorkspaceTaskSetupStep } from '@elevenex/shared';
import type { TaskWorkspaceSignal } from '../tasks';
import type { ProgressStep } from '../ui';

/**
 * Presents a task's workspace lifecycle from durable backend state. The steps
 * mirror the backend's preparation order; the renderer never infers progress
 * from elapsed time or guesses a step an older runtime did not report.
 */
const STEP_ORDER: Readonly<Record<WorkspaceTaskSetupStep, number>> = {
  queued: 0, fetching: 0, waiting: 1, checkout: 1, sessions: 2,
};

/** Steps that run long on large repositories; the pane says so after a while. */
export const SLOW_SETUP_MS = 20_000;

function branchLabel(task: WorkspaceTask): string {
  return task.branchName.replace(/^refs\/(heads|remotes)\//, '') || 'the branch';
}

function stepDetail(task: WorkspaceTask, step: WorkspaceTaskSetupStep): string | undefined {
  switch (step) {
    case 'queued': return 'Starting';
    case 'fetching': return 'Updating from the remote';
    case 'waiting': return 'Waiting its turn: setups in a repository run one at a time';
    case 'checkout': return `Checking out ${branchLabel(task)}`;
    case 'sessions': return undefined;
  }
}

/** Ordered setup steps, or null when the runtime reports none for this state. */
export function workspaceSetupSteps(task: WorkspaceTask, elapsedMs = 0): readonly ProgressStep[] | null {
  const step = task.setupStep;
  if (!step || (task.state !== 'preparing' && task.state !== 'failed') || task.setupIssue?.closeFailed) return null;
  const current = STEP_ORDER[step], failed = task.state === 'failed';
  const state = (index: number): ProgressStep['state'] =>
    index < current ? 'done' : index > current ? 'todo' : failed ? 'failed' : 'active';
  const detail = (index: number): string | undefined => {
    if (index !== current || failed) return undefined;
    // Only network and checkout work scales with repository size.
    if (elapsedMs >= SLOW_SETUP_MS && (step === 'fetching' || step === 'checkout'))
      return 'Large repositories can take a few minutes';
    return stepDetail(task, step);
  };
  return [
    { id: 'fetch', label: 'Fetch the latest commits', state: state(0), detail: detail(0) },
    { id: 'workspace', label: 'Prepare the workspace', state: state(1), detail: detail(1) },
    { id: 'session', label: 'Open the session', state: state(2), detail: detail(2) },
  ];
}

const STEP_SUMMARY: Readonly<Record<WorkspaceTaskSetupStep, string>> = {
  queued: 'starting',
  fetching: 'fetching the latest commits',
  waiting: 'waiting for the repository',
  checkout: 'checking out the branch',
  sessions: 'opening the session',
};

/**
 * One line for anywhere the task is visible without its setup pane: the
 * sidebar row and the open session. Null when the workspace is simply ready.
 */
export function workspaceTaskSignal(task: WorkspaceTask): TaskWorkspaceSignal | null {
  if (task.archivedAt) return null;
  const step = task.setupStep;
  switch (task.state) {
    case 'preparing':
      return { tone: 'working', label: 'Setting up', description: `Setting up workspace${step ? ` · ${STEP_SUMMARY[step]}` : ''}` };
    case 'failed':
      if (task.setupIssue?.closeFailed)
        return { tone: 'attention', label: 'Close failed', description: 'Closing didn’t finish. The workspace is still reserved.' };
      return { tone: 'attention', label: 'Needs setup', description: step
        ? `Setup stopped while ${STEP_SUMMARY[step]}. Your conversations are saved.`
        : 'The workspace needs attention. Your conversations are saved.' };
    case 'finishing':
      return { tone: 'working', label: 'Closing', description: 'Closing task · stopping its work and cleaning up the workspace' };
    case 'releasing':
      return { tone: 'working', label: 'Releasing', description: 'Releasing the workspace · your conversations are saved' };
    case 'released':
      return { tone: 'quiet', label: 'No workspace', description: 'Workspace released. Prepare one to continue; your conversations are saved.' };
    default:
      return null;
  }
}

/** `m:ss` for elapsed setup time; nothing for the first few seconds. */
export function setupElapsed(elapsedMs: number): string | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 5_000) return undefined;
  const seconds = Math.floor(elapsedMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
