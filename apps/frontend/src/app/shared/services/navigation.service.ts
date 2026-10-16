import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { finalize } from 'rxjs';
import { NavigationProject } from '../models/navigation-tree.model';
import { Session, SessionFolder } from '../models/session.model';
import { ClaudeStatusService } from './claude-status.service';
import { SidebarStateService } from './sidebar-state.service';
import { getBackendOrigin } from '../runtime/runtime-config';

type SessionCompletionPatch = Pick<
  Session,
  'hasUnreviewedCompletion' | 'lastCompletionAt' | 'lastCompletionKind' | 'lastStateChangeAt'
>;

@Injectable({ providedIn: 'root' })
export class NavigationService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private readonly sidebarState = inject(SidebarStateService);

  tree = signal<NavigationProject[]>([]);
  loading = signal(true);
  readonly expandedKeys = this.sidebarState.expandedKeys;
  revealProjectId = signal<number | null>(null);
  highlightedProjectId = signal<number | null>(null);
  private loadVersion = 0;
  private fullRefreshInFlight = false;
  private fullRefreshQueued = false;
  private cachedSessionNames = new Map<number, string>();
  private pendingTaskOrders = new Map<number, { origin: string; taskIds: number[] }>();
  private taskExpansionOrigin: string | null = null;
  private seenTaskKeys = new Set<string>();

  constructor() {
    const claudeStatus = inject(ClaudeStatusService);
    effect(() => {
      const count = claudeStatus.treeInvalidated();
      if (count > 0) {
        // loadTree reads and writes `tree`. Keep those implementation details
        // out of this effect's dependencies or every response schedules the
        // next refresh indefinitely after the first invalidation.
        untracked(() => this.refreshTree());
      }
    });
  }

  loadTree() {
    const version = ++this.loadVersion;
    const hasData = this.tree().length > 0;
    if (!hasData) {
      this.loading.set(true);
    }

    this.http.get<NavigationProject[]>('/api/navigation/tree/light').subscribe({
      next: (data) => {
        if (version !== this.loadVersion) {
          return;
        }
        const patched = this.applyCachedSessionNames(data);
        this.expandNewTasks(patched);
        this.tree.set(patched);
        this.loading.set(false);
        this.refreshFullTree(version);
      },
      error: () => this.loading.set(false),
    });
  }

  toggleExpand(key: string) {
    this.sidebarState.setExpanded(key, !this.isExpanded(key));
  }

  isExpanded(key: string): boolean {
    return this.expandedKeys().has(key);
  }

  expandKey(key: string) {
    if (this.isExpanded(key)) {
      return;
    }

    this.sidebarState.setExpanded(key, true);
  }

  expandTask(repoId: number, taskId: number): void {
    this.expandKey(`workspace-${repoId}-${taskId}`);
    this.expandKey(`repo-${repoId}`);
    const project = this.tree().find((item) => item.repos.some((repo) => repo.id === repoId));
    if (project) this.expandKey(`project-${project.id}`);
  }

  private expandNewTasks(projects: NavigationProject[]): void {
    const origin = getBackendOrigin();
    const initialLoad = this.taskExpansionOrigin !== origin;
    if (initialLoad) {
      this.taskExpansionOrigin = origin;
      this.seenTaskKeys.clear();
    }
    for (const project of projects) {
      for (const repo of project.repos) {
        for (const task of repo.workspaces ?? []) {
          if (task.isDefault) continue;
          const key = `workspace-${repo.id}-${task.id}`;
          if (!initialLoad && !this.seenTaskKeys.has(key) && !task.archivedAt) {
            this.expandKey(`project-${project.id}`);
            this.expandKey(`repo-${repo.id}`);
            this.expandKey(key);
          }
          // Remember tasks even if they disappear temporarily, so a refresh
          // never reopens a task the user has explicitly collapsed.
          this.seenTaskKeys.add(key);
        }
      }
    }
  }

  revealProject(projectId: number) {
    this.expandKey(`project-${projectId}`);
    this.revealProjectId.set(projectId);
    this.highlightedProjectId.set(projectId);
  }

  clearRevealProject(projectId: number) {
    if (this.revealProjectId() === projectId) {
      this.revealProjectId.set(null);
    }
  }

  clearHighlightedProject(projectId: number) {
    if (this.highlightedProjectId() === projectId) {
      this.highlightedProjectId.set(null);
    }
  }

  openSession(sessionId: number) {
    this.router.navigate(['/sessions', sessionId]);
  }

  patchSessionName(sessionId: number, name: string): void {
    this.cachedSessionNames.set(sessionId, name);
    this.applySessionNamePatch(sessionId, name);
  }

  previewTaskOrder(repoId: number, taskIds: number[]): void {
    this.pendingTaskOrders.set(repoId, { origin: getBackendOrigin(), taskIds });
    this.tree.update((projects) => this.applyPendingTaskOrders(projects));
  }

  finishTaskOrder(repoId: number, origin: string): void {
    if (this.pendingTaskOrders.get(repoId)?.origin === origin)
      this.pendingTaskOrders.delete(repoId);
    if (getBackendOrigin() === origin) this.refreshTree();
  }

  private applyPendingTaskOrders(projects: NavigationProject[]): NavigationProject[] {
    if (!this.pendingTaskOrders.size) return projects;
    const origin = getBackendOrigin();
    return projects.map((project) => ({
      ...project,
      repos: project.repos.map((repo) => {
        const pending = this.pendingTaskOrders.get(repo.id);
        if (!pending || pending.origin !== origin) return repo;
        const positions = new Map(pending.taskIds.map((id, index) => [id, index + 1]));
        return {
          ...repo,
          workspaces: repo.workspaces?.map((workspace) => ({
            ...workspace,
            sortOrder: positions.get(workspace.id) ?? workspace.sortOrder,
          })),
        };
      }),
    }));
  }

  addSessionFolder(folder: SessionFolder): void {
    this.tree.update((projects) =>
      projects.map((project) => ({
        ...project,
        repos: project.repos.map((repo) => ({
          ...repo,
          workspaces: (repo.workspaces ?? []).map((workspace) => {
            if (workspace.id !== folder.workspaceId) return workspace;
            const folders = workspace.sessionFolders ?? [];
            return folders.some((existing) => existing.id === folder.id)
              ? workspace
              : { ...workspace, sessionFolders: [...folders, folder] };
          }),
        })),
      })),
    );
  }

  private applySessionNamePatch(sessionId: number, name: string): void {
    this.tree.update((projects) =>
      projects.map((project) => ({
        ...project,
        repos: project.repos.map((repo) => ({
          ...repo,
          workspaces: (repo.workspaces ?? []).map((workspace) => ({
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === sessionId ? { ...session, name } : session,
            ),
            temporarySessions: workspace.temporarySessions?.map((session) =>
              session.id === sessionId ? { ...session, name } : session,
            ),
            archivedSessions: workspace.archivedSessions?.map((session) =>
              session.id === sessionId ? { ...session, name } : session,
            ),
            sessionFolders: workspace.sessionFolders?.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === sessionId ? { ...session, name } : session,
              ),
              archivedSessions: folder.archivedSessions.map((session) =>
                session.id === sessionId ? { ...session, name } : session,
              ),
            })),
            archivedSessionFolders: workspace.archivedSessionFolders?.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === sessionId ? { ...session, name } : session,
              ),
              archivedSessions: folder.archivedSessions.map((session) =>
                session.id === sessionId ? { ...session, name } : session,
              ),
            })),
          })),
        })),
      })),
    );
  }

  private applyCachedSessionNames(data: NavigationProject[]): NavigationProject[] {
    data = this.applyPendingTaskOrders(data);
    if (this.cachedSessionNames.size === 0) {
      return data;
    }
    return data.map((project) => ({
      ...project,
      repos: project.repos.map((repo) => ({
        ...repo,
        workspaces: (repo.workspaces ?? []).map((workspace) => ({
          ...workspace,
          sessions: workspace.sessions.map((session) => {
            const cached = this.cachedSessionNames.get(session.id);
            return cached !== undefined ? { ...session, name: cached } : session;
          }),
          temporarySessions: workspace.temporarySessions?.map((session) => {
            const cached = this.cachedSessionNames.get(session.id);
            return cached !== undefined ? { ...session, name: cached } : session;
          }),
          archivedSessions: workspace.archivedSessions?.map((session) => {
            const cached = this.cachedSessionNames.get(session.id);
            return cached !== undefined ? { ...session, name: cached } : session;
          }),
          sessionFolders: workspace.sessionFolders?.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) => {
              const cached = this.cachedSessionNames.get(session.id);
              return cached !== undefined ? { ...session, name: cached } : session;
            }),
            archivedSessions: folder.archivedSessions.map((session) => {
              const cached = this.cachedSessionNames.get(session.id);
              return cached !== undefined ? { ...session, name: cached } : session;
            }),
          })),
          archivedSessionFolders: workspace.archivedSessionFolders?.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) => {
              const cached = this.cachedSessionNames.get(session.id);
              return cached !== undefined ? { ...session, name: cached } : session;
            }),
            archivedSessions: folder.archivedSessions.map((session) => {
              const cached = this.cachedSessionNames.get(session.id);
              return cached !== undefined ? { ...session, name: cached } : session;
            }),
          })),
        })),
      })),
    }));
  }

  patchSessionCompletion(sessionId: number, completion: SessionCompletionPatch): void {
    this.tree.update((projects) =>
      projects.map((project) => ({
        ...project,
        repos: project.repos.map((repo) => ({
          ...repo,
          workspaces: (repo.workspaces ?? []).map((workspace) => ({
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === sessionId ? { ...session, ...completion } : session,
            ),
            archivedSessions: workspace.archivedSessions?.map((session) =>
              session.id === sessionId ? { ...session, ...completion } : session,
            ),
            sessionFolders: workspace.sessionFolders?.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === sessionId ? { ...session, ...completion } : session,
              ),
              archivedSessions: folder.archivedSessions.map((session) =>
                session.id === sessionId ? { ...session, ...completion } : session,
              ),
            })),
            archivedSessionFolders: workspace.archivedSessionFolders?.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === sessionId ? { ...session, ...completion } : session,
              ),
              archivedSessions: folder.archivedSessions.map((session) =>
                session.id === sessionId ? { ...session, ...completion } : session,
              ),
            })),
          })),
        })),
      })),
    );
  }

  refreshTree() {
    this.loadTree();
  }

  private refreshFullTree(version: number): void {
    if (this.fullRefreshInFlight) {
      this.fullRefreshQueued = true;
      return;
    }

    this.fullRefreshInFlight = true;
    this.http
      .get<NavigationProject[]>('/api/navigation/tree')
      .pipe(
        finalize(() => {
          this.fullRefreshInFlight = false;
          if (this.fullRefreshQueued) {
            this.fullRefreshQueued = false;
            this.refreshFullTree(this.loadVersion);
          }
        }),
      )
      .subscribe({
        next: (data) => {
          if (version !== this.loadVersion) {
            return;
          }
          const patched = this.applyCachedSessionNames(data);
          this.expandNewTasks(patched);
          this.tree.set(patched);
        },
        error: () => {
          // The light tree is already rendered; keep it if git reconciliation fails.
        },
      });
  }
}
