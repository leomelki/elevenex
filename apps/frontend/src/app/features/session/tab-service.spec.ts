import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TabService, readLastOpenedSessionId, LAST_OPENED_SESSION_STORAGE_KEY } from './tab-service';
import { Session } from '../../shared/models/session.model';

describe('TabService', () => {
  let service: TabService;

  const mockSession = (id: number, name?: string, status: Session['status'] = 'active'): Session => ({
    id,
    repoId: 1,
    projectId: 10,
    branchName: 'main',
    worktreePath: '/path/to/worktree',
    name: name ?? null,
    status,
    activeAgentProvider: 'claude',
    claudeSessionId: '-1',
    codexSessionId: '-1',
    hasInjectedWorktreeContext: false,
    hasUnreviewedCompletion: false,
    lastCompletionAt: null,
    lastCompletionKind: null,
    lastStateChangeAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    repoColor: null,
  });

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        clear: () => {
          store.clear();
        },
      },
      configurable: true,
    });

    TestBed.configureTestingModule({});
    localStorage.clear();
    service = TestBed.inject(TabService);
  });

  describe('openTab', () => {
    it('should open a tab with session data', () => {
      const session = mockSession(1, 'Test Session');
      service.openTab(session);

      expect(service.tabs()).toHaveLength(1);
      expect(service.tabs()[0].sessionId).toBe(1);
      expect(service.tabs()[0].sessionName).toBe('Test Session');
    });

    it('should set the opened tab as active', () => {
      service.openTab(mockSession(1, 'Session 1'));
      
      expect(service.activeSessionId()).toBe(1);
    });

    it('should not open duplicate tab for same session', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(1)); // Try to open again

      expect(service.tabs()).toHaveLength(1);
    });

    it('should select existing tab when trying to open duplicate', () => {
      service.openTab(mockSession(1, 'First'));
      service.openTab(mockSession(2, 'Second'));
      
      // Now try to open session 1 again
      service.openTab(mockSession(1));
      
      expect(service.tabs()).toHaveLength(2);
      expect(service.activeSessionId()).toBe(1);
    });

    it('should use default name when session has no name', () => {
      service.openTab(mockSession(5)); // No name

      expect(service.tabs()[0].sessionName).toBe('Session 5');
    });

    it('should infer Codex provider for an existing Codex-backed session', () => {
      service.openTab({
        ...mockSession(7),
        activeAgentProvider: 'claude',
        codexSessionId: 'codex-session-1',
      });

      expect(service.tabs()[0].activeAgentProvider).toBe('codex');
    });
  });

  describe('closeTab', () => {
    it('should close a tab and remove from list', () => {
      service.openTab(mockSession(1));
      service.closeTab(1);

      expect(service.tabs()).toHaveLength(0);
    });

    it('should return null when closing last tab', () => {
      service.openTab(mockSession(1));
      const result = service.closeTab(1);

      expect(result).toBeNull();
      expect(service.activeSessionId()).toBeNull();
    });

    it('should switch to adjacent tab when closing active tab (middle tab)', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.openTab(mockSession(3));
      service.selectTab(2); // Middle tab active

      const result = service.closeTab(2);

      // Should switch to tab at same index (now tab 3)
      expect(result).toBe(3);
      expect(service.activeSessionId()).toBe(3);
    });

    it('should switch to last tab when closing first tab', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.selectTab(1); // First tab active

      const result = service.closeTab(1);

      // Should switch to the remaining tab (2)
      expect(result).toBe(2);
      expect(service.activeSessionId()).toBe(2);
    });

    it('should keep current active tab when closing inactive tab', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.selectTab(1);

      const result = service.closeTab(2);

      expect(result).toBe(1);
      expect(service.activeSessionId()).toBe(1);
    });

    it('should handle closing non-existent tab', () => {
      service.openTab(mockSession(1));
      
      const result = service.closeTab(999);

      expect(result).toBe(1); // No change
      expect(service.tabs()).toHaveLength(1);
    });
  });

  describe('bulk close operations', () => {
    beforeEach(() => {
      service.openTab(mockSession(1, 'Session 1'));
      service.openTab(mockSession(2, 'Session 2'));
      service.openTab(mockSession(3, 'Session 3'));
      service.openTab(mockSession(4, 'Session 4'));
    });

    it('should close all tabs', () => {
      const result = service.closeAllTabs();

      expect(result).toEqual({
        activeSessionId: null,
        closedSessionIds: [1, 2, 3, 4],
      });
      expect(service.tabs()).toEqual([]);
      expect(service.activeSessionId()).toBeNull();
    });

    it('should close other tabs around an inactive clicked tab and make it active', () => {
      service.selectTab(4);

      const result = service.closeOtherTabs(2);

      expect(result).toEqual({
        activeSessionId: 2,
        closedSessionIds: [1, 3, 4],
      });
      expect(service.tabs().map(tab => tab.sessionId)).toEqual([2]);
      expect(service.activeSessionId()).toBe(2);
    });

    it('should close tabs to the right and keep active tab when it remains open', () => {
      service.selectTab(2);

      const result = service.closeTabsToRight(2);

      expect(result).toEqual({
        activeSessionId: 2,
        closedSessionIds: [3, 4],
      });
      expect(service.tabs().map(tab => tab.sessionId)).toEqual([1, 2]);
      expect(service.activeSessionId()).toBe(2);
    });

    it('should close tabs to the left and activate the clicked tab when active tab is removed', () => {
      service.selectTab(1);

      const result = service.closeTabsToLeft(3);

      expect(result).toEqual({
        activeSessionId: 3,
        closedSessionIds: [1, 2],
      });
      expect(service.tabs().map(tab => tab.sessionId)).toEqual([3, 4]);
      expect(service.activeSessionId()).toBe(3);
    });

    it('should no-op when closing tabs to the left of the first tab', () => {
      service.selectTab(2);

      const result = service.closeTabsToLeft(1);

      expect(result).toEqual({
        activeSessionId: 2,
        closedSessionIds: [],
      });
      expect(service.tabs().map(tab => tab.sessionId)).toEqual([1, 2, 3, 4]);
      expect(service.activeSessionId()).toBe(2);
    });

    it('should no-op when closing tabs to the right of the last tab', () => {
      service.selectTab(2);

      const result = service.closeTabsToRight(4);

      expect(result).toEqual({
        activeSessionId: 2,
        closedSessionIds: [],
      });
      expect(service.tabs().map(tab => tab.sessionId)).toEqual([1, 2, 3, 4]);
      expect(service.activeSessionId()).toBe(2);
    });

    it('should no-op for invalid session ids in bulk close operations', () => {
      const otherTabsResult = service.closeOtherTabs(999);
      const leftResult = service.closeTabsToLeft(999);
      const rightResult = service.closeTabsToRight(999);

      expect(otherTabsResult).toEqual({
        activeSessionId: 4,
        closedSessionIds: [],
      });
      expect(leftResult).toEqual({
        activeSessionId: 4,
        closedSessionIds: [],
      });
      expect(rightResult).toEqual({
        activeSessionId: 4,
        closedSessionIds: [],
      });
      expect(service.tabs().map(tab => tab.sessionId)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('selectTab', () => {
    it('should select a tab as active', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.selectTab(1);

      expect(service.activeSessionId()).toBe(1);
    });

    it('should not select tab that is not open', () => {
      service.openTab(mockSession(1));
      service.selectTab(999);

      expect(service.activeSessionId()).toBe(1); // No change
    });

    it('should persist the last opened session ID', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.selectTab(1);

      expect(localStorage.getItem(LAST_OPENED_SESSION_STORAGE_KEY)).toBe('1');
      expect(readLastOpenedSessionId()).toBe(1);
      expect(service.getLastOpenedSessionId()).toBe(1);
    });
  });

  describe('adjacent tab selection', () => {
    beforeEach(() => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.openTab(mockSession(3));
    });

    it('should select the tab to the right', () => {
      service.selectTab(2);

      const result = service.selectNextTab();

      expect(result).toBe(3);
      expect(service.activeSessionId()).toBe(3);
    });

    it('should wrap to the first tab when selecting next from the last tab', () => {
      service.selectTab(3);

      const result = service.selectNextTab();

      expect(result).toBe(1);
      expect(service.activeSessionId()).toBe(1);
    });

    it('should select the tab to the left', () => {
      service.selectTab(2);

      const result = service.selectPreviousTab();

      expect(result).toBe(1);
      expect(service.activeSessionId()).toBe(1);
    });

    it('should wrap to the last tab when selecting previous from the first tab', () => {
      service.selectTab(1);

      const result = service.selectPreviousTab();

      expect(result).toBe(3);
      expect(service.activeSessionId()).toBe(3);
    });

    it('should return null when there are no tabs', () => {
      service.closeAllTabs();

      expect(service.selectNextTab()).toBeNull();
      expect(service.selectPreviousTab()).toBeNull();
    });
  });

  describe('activeTab', () => {
    it('should return the active tab', () => {
      service.openTab(mockSession(1, 'Active Session'));
      
      const activeTab = service.activeTab();
      
      expect(activeTab).not.toBeNull();
      expect(activeTab?.sessionName).toBe('Active Session');
    });

    it('should return null when no tabs are open', () => {
      expect(service.activeTab()).toBeNull();
    });
  });

  describe('hasTabs', () => {
    it('should return false when no tabs', () => {
      expect(service.hasTabs()).toBe(false);
    });

    it('should return true when tabs exist', () => {
      service.openTab(mockSession(1));
      expect(service.hasTabs()).toBe(true);
    });
  });

  describe('updateTabStatus', () => {
    it('should update tab status', () => {
      service.openTab(mockSession(1, 'Test', 'active'));
      service.updateTabStatus(1, 'stopped');

      expect(service.tabs()[0].status).toBe('stopped');
    });

    it('should not affect other tabs', () => {
      service.openTab(mockSession(1, 'First', 'active'));
      service.openTab(mockSession(2, 'Second', 'active'));
      service.updateTabStatus(1, 'stopped');

      expect(service.tabs()[0].status).toBe('stopped');
      expect(service.tabs()[1].status).toBe('active');
    });
  });

  describe('updateTabCompletion', () => {
    it('should update tab completion marker fields', () => {
      service.openTab(mockSession(1, 'Test', 'active'));

      service.updateTabCompletion(1, {
        hasUnreviewedCompletion: true,
        lastCompletionAt: '2024-01-02T00:00:00.000Z',
        lastCompletionKind: 'completed',
      });

      expect(service.tabs()[0].hasUnreviewedCompletion).toBe(true);
      expect(service.tabs()[0].lastCompletionAt).toBe('2024-01-02T00:00:00.000Z');
      expect(service.tabs()[0].lastCompletionKind).toBe('completed');
    });
  });

  describe('getOpenSessionIds', () => {
    it('should return list of open session IDs', () => {
      service.openTab(mockSession(1));
      service.openTab(mockSession(2));
      service.openTab(mockSession(3));

      expect(service.getOpenSessionIds()).toEqual([1, 2, 3]);
    });

    it('should return empty array when no tabs', () => {
      expect(service.getOpenSessionIds()).toEqual([]);
    });
  });
});
