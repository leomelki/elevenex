import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { NavigationProject } from '../models/navigation-tree.model';
import { Session } from '../models/session.model';

type SessionCompletionPatch = Pick<Session, 'hasUnreviewedCompletion' | 'lastCompletionAt' | 'lastCompletionKind' | 'lastStateChangeAt'>;

@Injectable({ providedIn: 'root' })
export class NavigationService {
  private static STORAGE_KEY = 'elevenex-nav-expanded';

  private http = inject(HttpClient);
  private router = inject(Router);

  tree = signal<NavigationProject[]>([]);
  loading = signal(true);
  expandedKeys = signal<Set<string>>(this.loadExpandedKeys());
  revealProjectId = signal<number | null>(null);
  highlightedProjectId = signal<number | null>(null);

  loadTree() {
    const hasData = this.tree().length > 0;
    if (!hasData) {
      this.loading.set(true);
    }

    this.http.get<NavigationProject[]>('/api/navigation/tree/light').subscribe({
      next: (data) => {
        if (hasData) {
          this.expandNewTreeItems(this.tree(), data);
        }
        this.tree.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  toggleExpand(key: string) {
    const expanded = new Set(this.expandedKeys());
    if (expanded.has(key)) {
      expanded.delete(key);
    } else {
      expanded.add(key);
    }
    this.expandedKeys.set(expanded);
    this.saveExpandedKeys(expanded);
  }

  isExpanded(key: string): boolean {
    return this.expandedKeys().has(key);
  }

  expandKey(key: string) {
    if (this.isExpanded(key)) {
      return;
    }

    const expanded = new Set(this.expandedKeys());
    expanded.add(key);
    this.expandedKeys.set(expanded);
    this.saveExpandedKeys(expanded);
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

  patchSessionCompletion(sessionId: number, completion: SessionCompletionPatch): void {
    this.tree.update(projects => projects.map(project => ({
        ...project,
        repos: project.repos.map(repo => ({
          ...repo,
        workspaces: (repo.workspaces ?? []).map(workspace => ({
          ...workspace,
          sessions: workspace.sessions.map(session =>
            session.id === sessionId
              ? { ...session, ...completion }
              : session,
          ),
          archivedSessions: workspace.archivedSessions?.map(session =>
            session.id === sessionId
              ? { ...session, ...completion }
              : session,
          ),
        })),
      })),
    })));
  }

  refreshTree() {
    this.loadTree();
  }

  private loadExpandedKeys(): Set<string> {
    try {
      const stored = localStorage.getItem(NavigationService.STORAGE_KEY);
      if (stored) {
        return new Set(JSON.parse(stored));
      }
    } catch {
      // Ignore storage errors
    }
    return new Set();
  }

  private saveExpandedKeys(keys: Set<string>): void {
    try {
      localStorage.setItem(NavigationService.STORAGE_KEY, JSON.stringify([...keys]));
    } catch {
      // Ignore storage errors
    }
  }

  private expandNewTreeItems(previous: NavigationProject[], next: NavigationProject[]): void {
    const previousProjectIds = new Set(previous.map(project => project.id));
    const previousRepoIds = new Set(previous.flatMap(project => project.repos.map(repo => repo.id)));
    const previousWorkspaceKeys = new Set(previous.flatMap(project =>
      project.repos.flatMap(repo => (repo.workspaces ?? []).map(workspace => this.workspaceKey(repo.id, workspace.id))),
    ));
    const previousSessionIds = new Set(previous.flatMap(project =>
      project.repos.flatMap(repo =>
        (repo.workspaces ?? []).flatMap(workspace => [
          ...workspace.sessions,
          ...(workspace.archivedSessions ?? []),
        ].map(session => session.id)),
      ),
    ));

    const expanded = new Set(this.expandedKeys());
    let changed = false;
    const add = (key: string) => {
      if (expanded.has(key)) {
        return;
      }

      expanded.add(key);
      changed = true;
    };

    for (const project of next) {
      if (!previousProjectIds.has(project.id)) {
        add(`project-${project.id}`);
      }

      for (const repo of project.repos) {
        if (!previousRepoIds.has(repo.id)) {
          add(`project-${project.id}`);
          add(`repo-${repo.id}`);
        }

        for (const workspace of repo.workspaces ?? []) {
          const workspaceKey = this.workspaceKey(repo.id, workspace.id);
          const hasNewWorkspace = !previousWorkspaceKeys.has(workspaceKey);
          const hasNewSession = [
            ...workspace.sessions,
            ...(workspace.archivedSessions ?? []),
          ].some(session => !previousSessionIds.has(session.id));

          if (hasNewWorkspace || hasNewSession) {
            add(`project-${project.id}`);
            add(`repo-${repo.id}`);
            add(workspaceKey);
          }
        }
      }
    }

    if (changed) {
      this.expandedKeys.set(expanded);
      this.saveExpandedKeys(expanded);
    }
  }

  private workspaceKey(repoId: number, workspaceId: number): string {
    return `workspace-${repoId}-${workspaceId}`;
  }
}
