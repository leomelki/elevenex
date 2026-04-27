import { Injectable, signal } from '@angular/core';
import { ProjectBrowserStateSnapshot, ProjectBrowserTabState } from '@/shared/services/project-browser-state.service';

export interface BrowserTabItem extends ProjectBrowserTabState {
  label: string;
}

interface BrowserProjectTabState {
  projectId: number;
  activeTabId: string | null;
  tabs: ProjectBrowserTabState[];
}

const MAX_BROWSER_TABS = 3;

function createEmptyState(projectId: number): BrowserProjectTabState {
  return {
    projectId,
    activeTabId: null,
    tabs: [],
  };
}

@Injectable({ providedIn: 'root' })
export class BrowserTabsStateService {
  private readonly state = signal<Map<number, BrowserProjectTabState>>(new Map());

  readonly projects = this.state.asReadonly();
  readonly maxTabs = MAX_BROWSER_TABS;

  hasProject(projectId: number): boolean {
    return this.state().has(projectId);
  }

  ensureProject(projectId: number): BrowserProjectTabState {
    const existing = this.state().get(projectId);
    if (existing) {
      return existing;
    }

    const next = createEmptyState(projectId);
    this.state.update(current => new Map(current).set(projectId, next));
    return next;
  }

  hydrate(snapshot: ProjectBrowserStateSnapshot): void {
    const normalized = this.normalizeSnapshot(snapshot);
    this.state.update(current => new Map(current).set(snapshot.projectId, normalized));
  }

  getProjectState(projectId: number): BrowserProjectTabState {
    return this.state().get(projectId) ?? createEmptyState(projectId);
  }

  getTabs(projectId: number): ProjectBrowserTabState[] {
    return this.getProjectState(projectId).tabs;
  }

  getActiveTabId(projectId: number): string | null {
    return this.getProjectState(projectId).activeTabId;
  }

  getActiveTab(projectId: number): ProjectBrowserTabState | null {
    const state = this.getProjectState(projectId);
    return state.tabs.find(tab => tab.tabId === state.activeTabId) ?? null;
  }

  getTab(projectId: number, tabId: string): ProjectBrowserTabState | null {
    return this.getProjectState(projectId).tabs.find(tab => tab.tabId === tabId) ?? null;
  }

  canAddTab(projectId: number): boolean {
    return this.getTabs(projectId).length < MAX_BROWSER_TABS;
  }

  addTab(projectId: number, initialUrl = 'about:blank'): ProjectBrowserTabState | null {
    const current = this.ensureProject(projectId);
    if (current.tabs.length >= MAX_BROWSER_TABS) {
      return null;
    }

    const nextTab: ProjectBrowserTabState = {
      tabId: this.createTabId(projectId),
      url: initialUrl,
      position: current.tabs.length,
      customTitle: null,
    };

    this.commit(projectId, {
      activeTabId: nextTab.tabId,
      tabs: [...current.tabs, nextTab],
    });

    return nextTab;
  }

  selectTab(projectId: number, tabId: string): void {
    const state = this.getProjectState(projectId);
    if (!state.tabs.some(tab => tab.tabId === tabId)) {
      return;
    }

    this.commit(projectId, {
      activeTabId: tabId,
      tabs: state.tabs,
    });
  }

  closeTab(projectId: number, tabId: string): string | null {
    const state = this.getProjectState(projectId);
    const index = state.tabs.findIndex(tab => tab.tabId === tabId);
    if (index === -1) {
      return state.activeTabId;
    }

    const nextTabs = state.tabs
      .filter(tab => tab.tabId !== tabId)
      .map((tab, position) => ({ ...tab, position }));
    const nextActiveTabId = state.activeTabId === tabId
      ? nextTabs[Math.min(index, nextTabs.length - 1)]?.tabId ?? null
      : state.activeTabId;

    this.commit(projectId, {
      activeTabId: nextActiveTabId,
      tabs: nextTabs,
    });

    return nextActiveTabId;
  }

  updateTabUrl(projectId: number, tabId: string, url: string): void {
    const state = this.getProjectState(projectId);
    this.commit(projectId, {
      activeTabId: state.activeTabId,
      tabs: state.tabs.map(tab => tab.tabId === tabId ? { ...tab, url } : tab),
    });
  }

  renameTab(projectId: number, tabId: string, customTitle: string | null): void {
    const trimmed = customTitle?.trim() || null;
    const state = this.getProjectState(projectId);
    this.commit(projectId, {
      activeTabId: state.activeTabId,
      tabs: state.tabs.map(tab => tab.tabId === tabId ? { ...tab, customTitle: trimmed } : tab),
    });
  }

  removeProject(projectId: number): void {
    this.state.update(current => {
      if (!current.has(projectId)) {
        return current;
      }

      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  }

  createSnapshot(projectId: number): ProjectBrowserStateSnapshot {
    const state = this.getProjectState(projectId);
    return {
      projectId,
      activeTabId: state.activeTabId,
      tabs: state.tabs.map(tab => ({ ...tab })),
    };
  }

  private commit(projectId: number, nextState: Omit<BrowserProjectTabState, 'projectId'>): void {
    const normalized = this.normalizeSnapshot({
      projectId,
      activeTabId: nextState.activeTabId,
      tabs: nextState.tabs,
    });

    this.state.update(current => new Map(current).set(projectId, normalized));
  }

  private normalizeSnapshot(snapshot: ProjectBrowserStateSnapshot): BrowserProjectTabState {
    const tabs = [...snapshot.tabs]
      .sort((left, right) => left.position - right.position)
      .slice(0, MAX_BROWSER_TABS)
      .map((tab, position) => ({
        tabId: tab.tabId,
        url: tab.url,
        position,
        customTitle: tab.customTitle?.trim() || null,
      }));

    const activeTabId = tabs.some(tab => tab.tabId === snapshot.activeTabId)
      ? snapshot.activeTabId
      : tabs[0]?.tabId ?? null;

    return {
      projectId: snapshot.projectId,
      activeTabId,
      tabs,
    };
  }

  private createTabId(projectId: number): string {
    return `${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
