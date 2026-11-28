import type {
  BackendResult, ElevenexBridge, EnvironmentContext, WorkspacePage,
  WorkspaceProject, WorkspaceSession, WorkspaceTask,
} from '@elevenex/shared';
import { workspaceTaskStage } from './workspace.models';

type RestorationReads = Pick<ElevenexBridge, 'workspaceProjects' | 'workspaceTasks' | 'workspaceTask' | 'workspaceSessions'>;

export interface RestoredProjectWindow {
  readonly page: WorkspacePage<WorkspaceProject>;
  readonly cursor: string | undefined;
}

interface SessionWindow {
  readonly taskId: number;
  readonly page: WorkspacePage<WorkspaceSession>;
}

export interface RestoredTaskWindow {
  readonly page: WorkspacePage<WorkspaceTask>;
  readonly cursor: string | undefined;
  readonly closed: boolean;
  readonly sessions?: SessionWindow;
  readonly archive?: SessionWindow & { readonly cursor: string | undefined };
  readonly selection?: { readonly taskId: number; readonly sessionId: number };
  readonly pendingTask?: WorkspaceTask;
}

interface TaskRestorationRequest {
  readonly saved: EnvironmentContext;
  readonly projectId: number | null;
  readonly archiveHistory: boolean;
  readonly view: 'active' | 'closed' | 'linked';
}

/** The workspace protocol orders projects ascending and tasks/sessions descending
 * by numeric ID. Keep its exclusive keyset boundaries out of UI state owners.
 */
export function projectWindowCursor(projectId: number): string | undefined {
  return projectId > 1 ? String(projectId - 1) : undefined;
}

function historyWindowCursor(resourceId: number): string | undefined {
  return resourceId < Number.MAX_SAFE_INTEGER ? String(resourceId + 1) : undefined;
}

/** Read-only reconciliation. Returns bounded data; never owns or mutates UI state.
 * The caller owns cancellation through its scope/navigation lifetime predicate.
 */
export class WorkspaceRestoration {
  constructor(private readonly bridge: RestorationReads) {}

  async projects(scope: string, saved: EnvironmentContext, current: () => boolean): Promise<BackendResult<RestoredProjectWindow>> {
    let cursor = saved.workspace?.projectCursor ?? undefined;
    let result = await this.read(current, () => this.bridge.workspaceProjects(scope, { limit: 50, ...(cursor ? { cursor } : {}) }));
    if (!result.ok) return result;
    const containsProject = (page: WorkspacePage<WorkspaceProject>) => saved.projectId === null || page.items.some(project => project.id === saved.projectId);
    if (!containsProject(result.value) && saved.projectId !== null) {
      cursor = projectWindowCursor(saved.projectId);
      result = await this.read(current, () => this.bridge.workspaceProjects(scope, { limit: 50, ...(cursor ? { cursor } : {}) }));
      if (!result.ok) return result;
    }
    if (cursor && (!result.value.items.length || !containsProject(result.value))) {
      cursor = undefined;
      result = await this.read(current, () => this.bridge.workspaceProjects(scope, { limit: 50 }));
      if (!result.ok) return result;
    }
    return { ok: true, value: { page: result.value, cursor } };
  }

  async tasks(scope: string, request: TaskRestorationRequest, current: () => boolean): Promise<BackendResult<RestoredTaskWindow>> {
    const { saved, projectId, archiveHistory, view } = request;
    let closed = view === 'closed';
    // A saved task cursor belongs to its original project and list.
    let cursor = saved.projectId === projectId && (saved.workspace?.closed ?? false) === closed
      ? saved.workspace?.taskCursor ?? undefined : undefined;
    const readWindow = (cursor?: string) => this.read(current, () => this.bridge.workspaceTasks(scope, {
      projectId, state: closed ? 'finished' : 'active', limit: 20, ...(cursor ? { cursor } : {}),
    }));
    let tasks = await readWindow(cursor);
    if (!tasks.ok) return tasks;
    const defaultWindow = async (): Promise<BackendResult<RestoredTaskWindow>> => {
      const latest = cursor ? await readWindow() : tasks;
      return latest.ok ? { ok: true, value: { page: latest.value, cursor: undefined, closed } } : latest;
    };
    const taskId = saved.taskId;
    const findTask = (page: WorkspacePage<WorkspaceTask>) => page.items.find(task => task.id === taskId && (workspaceTaskStage(task) === 'closed') === closed);
    let task = findTask(tasks.value);
    if (taskId !== null && !task) {
      const result = await this.read(current, () => this.bridge.workspaceTask(scope, taskId));
      if (!result.ok) {
        if (result.error.code === 'http' && result.error.status === 404) return defaultWindow();
        return result.error.code === 'stale-scope' ? result : {
          ok: false, error: { ...result.error, message: 'The previous task could not be loaded. Refresh to try again.' },
        };
      }
      if (projectId !== null && result.value.projectId !== projectId) return defaultWindow();
      const taskClosed = workspaceTaskStage(result.value) === 'closed';
      if (view !== 'linked' && taskClosed !== closed) return defaultWindow();
      closed = taskClosed;
      cursor = historyWindowCursor(taskId);
      tasks = await readWindow(cursor);
      if (!tasks.ok) return tasks;
      task = findTask(tasks.value);
      if (!task) return defaultWindow();
    }
    if (!task && !tasks.value.items.length && cursor) return defaultWindow();
    const window: RestoredTaskWindow = { page: tasks.value, cursor, closed };
    if (!task) return { ok: true, value: window };
    if (saved.sessionId === null) {
      return { ok: true, value: { ...window, ...(task.state !== 'ready' && !closed ? { pendingTask: task } : {}) } };
    }
    return this.session(scope, window, task.id, saved.sessionId, archiveHistory, current);
  }

  private async session(scope: string, window: RestoredTaskWindow, taskId: number, sessionId: number, archiveHistory: boolean, current: () => boolean): Promise<BackendResult<RestoredTaskWindow>> {
    const latest = await this.read(current, () => this.bridge.workspaceSessions(scope, { taskId, order: 'latest', limit: 20 }));
    if (!latest.ok) return latest;
    const selection = { taskId, sessionId };
    const containsSession = (page: WorkspacePage<WorkspaceSession>) => page.items.some(session => session.id === sessionId);
    if (containsSession(latest.value)) return { ok: true, value: { ...window, sessions: { taskId, page: latest.value }, selection } };
    const cursor = historyWindowCursor(sessionId);
    const earlier = await this.read(current, () => this.bridge.workspaceSessions(scope, { taskId, order: 'latest', limit: 20, ...(cursor ? { cursor } : {}) }));
    if (!earlier.ok) return earlier;
    if (containsSession(earlier.value)) return { ok: true, value: { ...window, sessions: { taskId, page: earlier.value }, selection } };
    const unselected: RestoredTaskWindow = { ...window, sessions: { taskId, page: latest.value } };
    if (!archiveHistory || window.closed) return { ok: true, value: unselected };
    let archiveCursor = cursor;
    let archives = await this.read(current, () => this.bridge.workspaceSessions(scope, { taskId, state: 'archived', order: 'latest', limit: 20, ...(archiveCursor ? { cursor: archiveCursor } : {}) }));
    if (!archives.ok) return archives;
    // An empty older window does not establish whether any archives remain.
    if (archiveCursor && !archives.value.items.length) {
      archiveCursor = undefined;
      archives = await this.read(current, () => this.bridge.workspaceSessions(scope, { taskId, state: 'archived', order: 'latest', limit: 20 }));
      if (!archives.ok) return archives;
    }
    return { ok: true, value: { ...unselected, archive: { taskId, page: archives.value, cursor: archiveCursor }, ...(containsSession(archives.value) ? { selection } : {}) } };
  }

  private async read<T>(current: () => boolean, operation: () => Promise<BackendResult<T>>): Promise<BackendResult<T>> {
    const stale: BackendResult<never> = { ok: false, error: { code: 'stale-scope', message: 'Workspace restoration was interrupted.' } };
    if (!current()) return stale;
    try {
      const result = await operation();
      return current() ? result : stale;
    } catch {
      return current() ? { ok: false, error: { code: 'transport', message: 'The backend could not be reached. Refresh to reconnect.' } } : stale;
    }
  }
}
