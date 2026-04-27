import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { NavigationProject } from '../models/navigation-tree.model';

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
}
