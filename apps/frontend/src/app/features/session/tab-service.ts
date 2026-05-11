import { Injectable, signal, computed } from '@angular/core';
import { Session } from '../../shared/models/session.model';
import type { AgentProviderId } from '../../shared/models/agent-runtime.model';

export const LAST_OPENED_SESSION_STORAGE_KEY = 'elevenex-last-opened-session';
export const OPEN_TABS_STORAGE_KEY = 'elevenex-open-tabs';

export function readLastOpenedSessionId(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): number | null {
  if (!storage) {
    return null;
  }

  try {
    const stored = storage.getItem(LAST_OPENED_SESSION_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const sessionId = Number(stored);
    return Number.isInteger(sessionId) && sessionId > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

export interface Tab {
  sessionId: number;
  sessionName: string;
  branchName: string;
  worktreePath: string;
  status: Session['status'];
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: Session['lastCompletionKind'];
  repoId: number;
  projectId: number;
  repoColor?: string | null;
  hasInjectedWorktreeContext: boolean;
  activeAgentProvider: AgentProviderId;
  hasStartedAgentRuntime: boolean;
}

export interface TabCloseResult {
  activeSessionId: number | null;
  closedSessionIds: number[];
}

@Injectable({ providedIn: 'root' })
export class TabService {
  private static STORAGE_KEY = OPEN_TABS_STORAGE_KEY;

  private _tabs = signal<Tab[]>([]);
  private _activeSessionId = signal<number | null>(null);

  // Public readonly signals
  readonly tabs = this._tabs.asReadonly();
  readonly activeSessionId = this._activeSessionId.asReadonly();

  // Computed signals
  readonly activeTab = computed(() => {
    const id = this._activeSessionId();
    if (!id) return null;
    return this._tabs().find(t => t.sessionId === id) ?? null;
  });

  readonly hasTabs = computed(() => this._tabs().length > 0);

  /**
   * Open a tab for a session. If already open, just select it.
   */
  openTab(session: Session): void {
    const existing = this._tabs().find(t => t.sessionId === session.id);
    if (existing) {
      this._tabs.update(tabs =>
        tabs.map(t =>
          t.sessionId === session.id
            ? {
                ...t,
                activeAgentProvider: this.providerForSession(session),
                hasStartedAgentRuntime: this.hasStartedAgentRuntime(session),
              }
            : t,
        ),
      );
      this._activeSessionId.set(session.id);
      this.persistLastOpenedSession(session.id);
      this.persistState();
      return;
    }

    const newTab: Tab = {
      sessionId: session.id,
      sessionName: session.name ?? `Session ${session.id}`,
      branchName: session.branchName,
      worktreePath: session.worktreePath,
      status: session.status,
      hasUnreviewedCompletion: session.hasUnreviewedCompletion,
      lastCompletionAt: session.lastCompletionAt,
      lastCompletionKind: session.lastCompletionKind,
      repoId: session.repoId,
      projectId: session.projectId,
      repoColor: session.repoColor,
      hasInjectedWorktreeContext: session.hasInjectedWorktreeContext,
      activeAgentProvider: this.providerForSession(session),
      hasStartedAgentRuntime: this.hasStartedAgentRuntime(session),
    };

    this._tabs.update(tabs => [...tabs, newTab]);
    this._activeSessionId.set(session.id);
    this.persistLastOpenedSession(session.id);
    this.persistState();
  }

  /**
   * Close a tab. If closing active tab, switch to adjacent tab.
   * Returns the new active session ID or null if no tabs left.
   */
  closeTab(sessionId: number): number | null {
    const tabs = this._tabs();
    const index = tabs.findIndex(t => t.sessionId === sessionId);

    if (index === -1) return this._activeSessionId();

    // Remove tab
    this._tabs.update(t => t.filter(tab => tab.sessionId !== sessionId));

    // If closing active tab, switch to adjacent
    if (this._activeSessionId() === sessionId) {
      const remaining = this._tabs();
      if (remaining.length === 0) {
        this._activeSessionId.set(null);
        this.persistState();
        return null;
      }

      // Switch to tab at same index, or last tab
      const newIndex = Math.min(index, remaining.length - 1);
      const newActiveId = remaining[newIndex].sessionId;
      this._activeSessionId.set(newActiveId);
      this.persistState();
      return newActiveId;
    }

    this.persistState();
    return this._activeSessionId();
  }

  closeAllTabs(): TabCloseResult {
    const closedSessionIds = this._tabs().map(tab => tab.sessionId);
    if (closedSessionIds.length === 0) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    this._tabs.set([]);
    this._activeSessionId.set(null);
    this.persistState();

    return {
      activeSessionId: null,
      closedSessionIds,
    };
  }

  closeOtherTabs(sessionId: number): TabCloseResult {
    const tabs = this._tabs();
    const targetTab = tabs.find(tab => tab.sessionId === sessionId);
    if (!targetTab) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    const closedSessionIds = tabs
      .filter(tab => tab.sessionId !== sessionId)
      .map(tab => tab.sessionId);

    if (closedSessionIds.length === 0) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    this._tabs.set([targetTab]);
    this._activeSessionId.set(sessionId);
    this.persistLastOpenedSession(sessionId);
    this.persistState();

    return {
      activeSessionId: sessionId,
      closedSessionIds,
    };
  }

  closeTabsToLeft(sessionId: number): TabCloseResult {
    const tabs = this._tabs();
    const index = tabs.findIndex(tab => tab.sessionId === sessionId);
    if (index === -1) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    const closedSessionIds = tabs.slice(0, index).map(tab => tab.sessionId);
    if (closedSessionIds.length === 0) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    this._tabs.set(tabs.slice(index));

    if (closedSessionIds.includes(this._activeSessionId() ?? -1)) {
      this._activeSessionId.set(sessionId);
      this.persistLastOpenedSession(sessionId);
    }

    this.persistState();
    return {
      activeSessionId: this._activeSessionId(),
      closedSessionIds,
    };
  }

  closeTabsToRight(sessionId: number): TabCloseResult {
    const tabs = this._tabs();
    const index = tabs.findIndex(tab => tab.sessionId === sessionId);
    if (index === -1) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    const closedSessionIds = tabs.slice(index + 1).map(tab => tab.sessionId);
    if (closedSessionIds.length === 0) {
      return {
        activeSessionId: this._activeSessionId(),
        closedSessionIds: [],
      };
    }

    this._tabs.set(tabs.slice(0, index + 1));
    this.persistState();

    return {
      activeSessionId: this._activeSessionId(),
      closedSessionIds,
    };
  }

  /**
   * Select a tab as active.
   */
  selectTab(sessionId: number): void {
    if (this._tabs().some(t => t.sessionId === sessionId)) {
      this._activeSessionId.set(sessionId);
      this.persistLastOpenedSession(sessionId);
      this.persistState();
    }
  }

  selectNextTab(): number | null {
    return this.selectAdjacentTab(1);
  }

  selectPreviousTab(): number | null {
    return this.selectAdjacentTab(-1);
  }

  /**
   * Update tab status when session status changes.
   */
  updateTabStatus(sessionId: number, status: Session['status']): void {
    const current = this._tabs().find(t => t.sessionId === sessionId);
    if (!current || current.status === status) return;
    this._tabs.update(tabs =>
      tabs.map(t =>
        t.sessionId === sessionId ? { ...t, status } : t
      )
    );
  }

  updateTabCompletion(
    sessionId: number,
    completion: Pick<Session, 'hasUnreviewedCompletion' | 'lastCompletionAt' | 'lastCompletionKind'>,
  ): void {
    const current = this._tabs().find(t => t.sessionId === sessionId);
    if (
      !current ||
      (current.hasUnreviewedCompletion === completion.hasUnreviewedCompletion &&
        current.lastCompletionAt === completion.lastCompletionAt &&
        current.lastCompletionKind === completion.lastCompletionKind)
    ) {
      return;
    }

    this._tabs.update(tabs =>
      tabs.map(t =>
        t.sessionId === sessionId
          ? {
              ...t,
              hasUnreviewedCompletion: completion.hasUnreviewedCompletion,
              lastCompletionAt: completion.lastCompletionAt,
              lastCompletionKind: completion.lastCompletionKind,
            }
          : t,
      ),
    );
  }

  /**
   * Update tab name when session name changes.
   */
  updateTabName(sessionId: number, name: string): void {
    this._tabs.update(tabs =>
      tabs.map(t =>
        t.sessionId === sessionId ? { ...t, sessionName: name } : t
      )
    );
  }

  updateTabProvider(sessionId: number, provider: AgentProviderId): void {
    const current = this._tabs().find(t => t.sessionId === sessionId);
    if (!current || current.activeAgentProvider === provider) return;
    this._tabs.update(tabs =>
      tabs.map(t =>
        t.sessionId === sessionId ? { ...t, activeAgentProvider: provider } : t
      )
    );
    this.persistState();
  }

  markTabRuntimeStarted(sessionId: number): void {
    const current = this._tabs().find(t => t.sessionId === sessionId);
    if (!current || current.hasStartedAgentRuntime) return;
    this._tabs.update(tabs =>
      tabs.map(t =>
        t.sessionId === sessionId ? { ...t, hasStartedAgentRuntime: true } : t
      )
    );
    this.persistState();
  }

  /**
   * Get all open session IDs.
   */
  getOpenSessionIds(): number[] {
    return this._tabs().map(t => t.sessionId);
  }

  /**
   * Get sessions grouped by worktree path.
   * Useful for displaying "multiple sessions per worktree" indicator.
   */
  getSessionsByWorktree(): Map<string, Tab[]> {
    const byWorktree = new Map<string, Tab[]>();
    for (const tab of this._tabs()) {
      const existing = byWorktree.get(tab.worktreePath) || [];
      existing.push(tab);
      byWorktree.set(tab.worktreePath, existing);
    }
    return byWorktree;
  }

  /**
   * Check if a worktree has multiple open sessions.
   */
  hasMultipleSessionsInWorktree(worktreePath: string): boolean {
    const tabs = this._tabs().filter(t => t.worktreePath === worktreePath);
    return tabs.length > 1;
  }

  /**
   * Get all tabs for a specific worktree.
   */
  getTabsByWorktree(worktreePath: string): Tab[] {
    return this._tabs().filter(t => t.worktreePath === worktreePath);
  }

  getSavedState(): { sessionIds: number[]; activeSessionId: number | null } | null {
    try {
      const stored = localStorage.getItem(TabService.STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // Ignore storage errors
    }
    return null;
  }

  getLastOpenedSessionId(): number | null {
    return readLastOpenedSessionId();
  }

  resetForEnvironmentChange(): TabCloseResult {
    const closedSessionIds = this._tabs().map(tab => tab.sessionId);
    this._tabs.set([]);
    this._activeSessionId.set(null);

    try {
      localStorage.removeItem(LAST_OPENED_SESSION_STORAGE_KEY);
      localStorage.removeItem(TabService.STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }

    return {
      activeSessionId: null,
      closedSessionIds,
    };
  }

  private selectAdjacentTab(direction: 1 | -1): number | null {
    const tabs = this._tabs();
    if (tabs.length === 0) {
      return null;
    }

    const activeSessionId = this._activeSessionId();
    const currentIndex = activeSessionId
      ? tabs.findIndex(tab => tab.sessionId === activeSessionId)
      : -1;
    const nextSessionId = currentIndex === -1
      ? tabs[direction === 1 ? 0 : tabs.length - 1]?.sessionId ?? null
      : tabs[(currentIndex + direction + tabs.length) % tabs.length]?.sessionId ?? null;

    if (nextSessionId !== null) {
      this.selectTab(nextSessionId);
    }

    return nextSessionId;
  }

  private persistLastOpenedSession(sessionId: number): void {
    try {
      localStorage.setItem(LAST_OPENED_SESSION_STORAGE_KEY, String(sessionId));
    } catch {
      // Ignore storage errors
    }
  }

  private persistState(): void {
    try {
      const state = {
        sessionIds: this._tabs().map(t => t.sessionId),
        activeSessionId: this._activeSessionId(),
      };
      localStorage.setItem(TabService.STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage errors
    }
  }

  private providerForSession(session: Session): AgentProviderId {
    const persisted = session.activeAgentProvider?.trim();
    const hasPi = Boolean(session.piSessionPath && session.piSessionPath !== '-1');
    if (
      persisted
      && (persisted !== 'claude' || session.claudeSessionId !== '-1' || (session.codexSessionId === '-1' && !hasPi))
    ) {
      return persisted;
    }
    if (hasPi) return 'pi';
    return session.codexSessionId && session.codexSessionId !== '-1' ? 'codex' : 'claude';
  }

  private hasStartedAgentRuntime(session: Session): boolean {
    return Boolean(
      (session.claudeSessionId && session.claudeSessionId !== '-1')
        || (session.codexSessionId && session.codexSessionId !== '-1')
        || (session.piSessionPath && session.piSessionPath !== '-1'),
    );
  }
}
