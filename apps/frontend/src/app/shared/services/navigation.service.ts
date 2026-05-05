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
        branches: repo.branches.map(branch => ({
          ...branch,
          sessions: branch.sessions.map(session =>
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
    const previousBranchKeys = new Set(previous.flatMap(project =>
      project.repos.flatMap(repo => repo.branches.map(branch => this.branchKey(repo.id, branch.name))),
    ));
    const previousSessionIds = new Set(previous.flatMap(project =>
      project.repos.flatMap(repo =>
        repo.branches.flatMap(branch => branch.sessions.map(session => session.id)),
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

        for (const branch of repo.branches) {
          const branchKey = this.branchKey(repo.id, branch.name);
          const hasNewBranch = !previousBranchKeys.has(branchKey);
          const hasNewSession = branch.sessions.some(session => !previousSessionIds.has(session.id));

          if (hasNewBranch || hasNewSession) {
            add(`project-${project.id}`);
            add(`repo-${repo.id}`);
            add(branchKey);
          }
        }
      }
    }

    if (changed) {
      this.expandedKeys.set(expanded);
      this.saveExpandedKeys(expanded);
    }
  }

  private branchKey(repoId: number, branchName: string): string {
    return `branch-${repoId}-${branchName}`;
  }
}
