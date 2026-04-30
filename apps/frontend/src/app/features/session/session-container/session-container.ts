import { Component, inject, Injector, OnInit, OnDestroy, afterNextRender, effect, signal, computed, viewChild, viewChildren, untracked, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, NavigationEnd } from '@angular/router';
import { filter, takeUntil, switchMap, catchError } from 'rxjs/operators';
import { Subject, interval, from, forkJoin, of } from 'rxjs';
import { TabBar } from '../tab-bar/tab-bar';
import { Tab, TabCloseResult, TabService } from '../tab-service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { NavigationService } from '../../../shared/services/navigation.service';
import { ClaudeTerminalComponent } from '../terminal';
import { ClaudeWorkspaceComponent } from '../claude-workspace';
import { VSCodeWebPanelComponent } from '@/features/vscode-web';
import { BrowserPanelComponent } from '@/features/browser-panel/browser-panel.component';
import { ScratchpadPanelComponent } from '@/features/productivity/scratchpad-panel/scratchpad-panel';
import { TodoPanelComponent } from '@/features/productivity/todo-panel/todo-panel';
import { TodosService } from '@/features/productivity/todos.service';
import { ProductivityStateService } from '@/features/productivity/productivity-state.service';
import { ZardResizableComponent, ZardResizablePanelComponent, ZardResizableHandleComponent, ZardResizeEvent } from '@/shared/components/resizable';
import { PlannotatorEvent, PlannotatorPanelComponent, PlannotatorService, PlannotatorStateService } from '@/features/plannotator';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';
import { ActionsPanelComponent, ActionsStateService } from '@/features/actions';
import { UserTerminalPanelComponent, UserTerminalStateService } from '@/features/user-terminal';
import { VSCodeWebStateService, buildVSCodeIframeKey } from '@/features/vscode-web/vscode-web-state.service';
import { BrowserViewStateService, buildBrowserViewProjectPrefix } from '@/features/browser-panel/browser-view-state.service';
import { getElectronBrowserApi } from '@/shared/runtime/electron-browser';
import { BrowserTabsStateService } from '@/features/browser-panel/browser-tabs-state.service';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { BrowserIsolationConfig } from '@/shared/models/browser-isolation.model';
import { toast } from 'ngx-sonner';
import { GitHubPanelComponent } from '@/features/github/github-panel.component';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { Session } from '@/shared/models/session.model';
import { shouldAutoReviewSessionCompletion } from '../session-completion-review.util';
import { shouldCloseActiveSessionTab } from '../close-tab-shortcut.util';
import { ModalOverlayStateService } from '@/shared/services/modal-overlay-state.service';
import { SshRuntimeRecoveryService } from '@/shared/services/ssh-runtime-recovery.service';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-session-container',
  standalone: true,
  imports: [
    CommonModule,
    TabBar,
    ClaudeTerminalComponent,
    ClaudeWorkspaceComponent,
    VSCodeWebPanelComponent,
    BrowserPanelComponent,
    ScratchpadPanelComponent,
    TodoPanelComponent,
    ZardResizableComponent,
    ZardResizablePanelComponent,
    ZardResizableHandleComponent,
    PlannotatorPanelComponent,
    ActionsPanelComponent,
    UserTerminalPanelComponent,
    GitHubPanelComponent,
    TrackNativeModalDirective,
  ],
  templateUrl: './session-container.html',
  host: { class: 'flex-1 min-h-0' },
})
export class SessionContainer implements OnInit, OnDestroy {
  private static readonly SIDEBAR_MODE_STORAGE_KEY = 'elevenex-layout-preferences';

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private tabService = inject(TabService);
  private sessionsService = inject(SessionsService);
  private navService = inject(NavigationService);
  private productivityState = inject(ProductivityStateService);
  private plannotatorService = inject(PlannotatorService);
  private plannotatorState = inject(PlannotatorStateService);
  private actionsState = inject(ActionsStateService);
  private todosService = inject(TodosService);
  private userTerminalState = inject(UserTerminalStateService);
  private vscodeWebState = inject(VSCodeWebStateService);
  private browserViewState = inject(BrowserViewStateService);
  private browserTabsState = inject(BrowserTabsStateService);
  private browserIsolationService = inject(BrowserIsolationService);
  private claudeStatusService = inject(ClaudeStatusService);
  private sshRuntimeRecovery = inject(SshRuntimeRecoveryService);
  private modalOverlayState = inject(ModalOverlayStateService);
  private injector = inject(Injector);
  private destroy$ = new Subject<void>();

  private isolationConfigCache = new Map<number, BrowserIsolationConfig>();
  browserIsolationConfig = signal<BrowserIsolationConfig | null>(null);

  showDeleteDialog = signal(false);
  deleteTargetSessionId = signal<number | null>(null);
  protected readonly browserPanelMounted = signal(true);

  claudeTerminals = viewChildren(ClaudeTerminalComponent);
  claudeWorkspaces = viewChildren(ClaudeWorkspaceComponent);
  private readonly browserPanel = viewChild(BrowserPanelComponent);

  tabs = this.tabService.tabs;
  activeSessionId = this.tabService.activeSessionId;
  hasTabs = this.tabService.hasTabs;
  activeTab = this.tabService.activeTab;

  // Computed worktreePath from active session
  worktreePath = computed(() => {
    const activeId = this.activeSessionId();
    const tab = this.tabs().find(t => t.sessionId === activeId);
    return tab?.worktreePath ?? null;
  });

  // Computed projectId from active session
  projectId = computed(() => {
    const tab = this.activeTab();
    return tab?.projectId ?? null;
  });

  // Panel visibility - depend on states signal for reactivity
  showScratchpad = computed(() => {
    const pid = this.projectId();
    if (!pid) return false;
    const states = this.productivityState.states();
    return states.get(pid)?.scratchpad ?? false;
  });

  showTodos = computed(() => {
    const pid = this.projectId();
    if (!pid) return false;
    const states = this.productivityState.states();
    return states.get(pid)?.todos ?? false;
  });

  sidePanelMode = signal<'none' | 'files' | 'browser' | 'github'>(this.getSidePanelPreference());
  claudeSurfaceMode = signal<'workspace' | 'terminal'>('workspace');
  showFilesPanel = computed(() => this.sidePanelMode() === 'files');
  showBrowserPanel = computed(() => this.sidePanelMode() === 'browser');
  showGithubPanel = computed(() => this.sidePanelMode() === 'github');
  showClaudeTerminalFallback = computed(() => this.claudeSurfaceMode() === 'terminal');

  // User terminal panel visibility
  terminalPanelVisible = computed(() => {
    const wt = this.worktreePath();
    if (!wt) return false;
    return this.userTerminalState.isPanelOpen(wt);
  });

  actionPanelVisible = computed(() => {
    const wt = this.worktreePath();
    if (!wt) return false;
    return this.actionsState.isPanelOpen(wt);
  });

  bottomPanelVisible = computed(() => this.terminalPanelVisible() || this.actionPanelVisible());

  runningActionsCount = computed(() => {
    const wt = this.worktreePath();
    if (!wt) return 0;
    return this.actionsState.getRunningCount(wt);
  });

  pendingTodosCount = computed(() => {
    const pid = this.projectId();
    if (!pid) return 0;
    // Read the signal to get reactive updates
    this.todosService.pendingCountsSignal();
    return this.todosService.getPendingCount(pid);
  });

  // Plannotator panel state
  showPlannotator = computed(() => {
    const sessionId = this.activeSessionId();
    if (!sessionId) return false;
    return this.plannotatorState.isPanelVisible(sessionId);
  });

  activePlannotatorPanel = computed(() => {
    const sessionId = this.activeSessionId();
    if (!sessionId) return null;
    return this.plannotatorState.getPanel(sessionId);
  });

  readonly hasBlockingOverlayPanel = computed(() => {
    const plannotatorPanel = this.activePlannotatorPanel();
    return this.showScratchpad()
      || this.showTodos()
      || this.modalOverlayState.hasOpenModal()
      || Boolean(plannotatorPanel?.visible && !plannotatorPanel.minimized);
  });

  readonly shouldShowBrowserPlaceholder = computed(() =>
    this.showBrowserPanel() && this.hasBlockingOverlayPanel(),
  );

  readonly shouldRenderBrowserPanel = computed(() =>
    this.showBrowserPanel() && !this.hasBlockingOverlayPanel() && this.browserPanelMounted(),
  );

  private getSidePanelPreference(): 'none' | 'files' | 'browser' | 'github' {
    try {
      const stored = localStorage.getItem(SessionContainer.SIDEBAR_MODE_STORAGE_KEY);
      if (stored) {
        const prefs = JSON.parse(stored);
        if (prefs.sidePanelMode === 'github') {
          return 'none';
        }
        if (prefs.sidePanelMode === 'files' || prefs.sidePanelMode === 'browser' || prefs.sidePanelMode === 'none') {
          return prefs.sidePanelMode;
        }

        if (typeof prefs.filesPanelVisible === 'boolean') {
          return prefs.filesPanelVisible ? 'files' : 'none';
        }
      }
    } catch {
      // Ignore storage errors
    }
    return 'files';
  }

  private saveSidePanelPreference(mode: 'none' | 'files' | 'browser' | 'github'): void {
    try {
      const stored = localStorage.getItem(SessionContainer.SIDEBAR_MODE_STORAGE_KEY);
      const current = stored ? JSON.parse(stored) : {};
      const persistedMode = mode === 'github' ? 'none' : mode;
      localStorage.setItem(SessionContainer.SIDEBAR_MODE_STORAGE_KEY, JSON.stringify({
        ...current,
        filesPanelVisible: persistedMode === 'files',
        sidePanelMode: persistedMode,
      }));
    } catch {
      // Ignore storage errors
    }
  }

  toggleTerminalPanel(): void {
    const wt = this.worktreePath();
    if (wt) {
      const next = !this.userTerminalState.isPanelOpen(wt);
      this.userTerminalState.setPanelOpen(wt, next);
      if (next) {
        this.actionsState.setPanelOpen(wt, false);
      }
    }
  }

  toggleActionsPanel(): void {
    const wt = this.worktreePath();
    if (wt) {
      const next = !this.actionsState.isPanelOpen(wt);
      this.actionsState.setPanelOpen(wt, next);
      if (next) {
        this.userTerminalState.setPanelOpen(wt, false);
      }
    }
  }

  toggleFilesPanel(): void {
    const nextMode = this.showFilesPanel() ? 'none' : 'files';
    this.sidePanelMode.set(nextMode);
    this.saveSidePanelPreference(nextMode);
  }

  toggleBrowserPanel(): void {
    const nextMode = this.showBrowserPanel() ? 'none' : 'browser';
    this.sidePanelMode.set(nextMode);
    this.saveSidePanelPreference(nextMode);
  }

  onOpenInBrowser(url: string): void {
    if (getElectronBrowserApi()) {
      this.sidePanelMode.set('browser');
      this.saveSidePanelPreference('browser');
      afterNextRender(() => {
        void this.browserPanel()?.navigateToUrl(url);
      }, { injector: this.injector });
      return;
    }

    // Web/SSH mode: proxy localhost URLs through the backend
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        const port = parsed.port || '80';
        const proxyUrl = `/api/mcp-auth-proxy/${port}${parsed.pathname}${parsed.search}`;
        window.open(proxyUrl, '_blank');
        return;
      }
    } catch {
      // fall through to default
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  toggleGithubPanel(): void {
    const nextMode = this.showGithubPanel() ? 'none' : 'github';
    this.sidePanelMode.set(nextMode);
    this.saveSidePanelPreference(nextMode);
  }

  toggleClaudeTerminalFallback(): void {
    this.claudeSurfaceMode.update(mode => mode === 'workspace' ? 'terminal' : 'workspace');
  }

  showClaudeWorkspace(): void {
    this.claudeSurfaceMode.set('workspace');
  }

  showClaudeTerminal(): void {
    this.claudeSurfaceMode.set('terminal');
  }

  onIsolationConfigChanged(config: BrowserIsolationConfig): void {
    this.isolationConfigCache.set(config.projectId, config);
    this.browserIsolationConfig.set(config);
  }

  private saveLayoutPreference(prefs: Partial<{ terminalSize: number; editorSize: number; userTerminalSize: number }>): void {
    try {
      const stored = localStorage.getItem(SessionContainer.SIDEBAR_MODE_STORAGE_KEY);
      const current = stored ? JSON.parse(stored) : {};
      localStorage.setItem(SessionContainer.SIDEBAR_MODE_STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
    } catch {
      // Ignore storage errors
    }
  }

  onVerticalResizeEnd(event: ZardResizeEvent): void {
    if (!this.bottomPanelVisible()) return;
    this.saveLayoutPreference({ userTerminalSize: event.sizes[1] });
  }

  onResizeEnd(event: ZardResizeEvent): void {
    if (this.sidePanelMode() === 'none') return;
    const prefs: Partial<{ terminalSize: number; editorSize: number }> = {
      terminalSize: event.sizes[0],
      editorSize: event.sizes[1],
    };
    this.saveLayoutPreference(prefs);
  }

  constructor() {
    effect(() => {
      const activeId = this.activeSessionId();
      if (activeId && this.showClaudeTerminalFallback()) {
        setTimeout(() => {
          const terminal = this.claudeTerminals().find(t => t.sessionId === activeId);
          terminal?.fit();
          terminal?.focus();
        }, 0);
      }
    });

    effect(() => {
      if (this.hasBlockingOverlayPanel()) {
        this.browserPanelMounted.set(false);
        return;
      }

      this.browserPanelMounted.set(true);
    });

    effect(() => {
      const pid = this.projectId();
      if (!pid) {
        this.browserIsolationConfig.set(null);
        return;
      }

      const cached = this.isolationConfigCache.get(pid);
      if (cached) {
        this.browserIsolationConfig.set(cached);
        return;
      }

      this.browserIsolationService.get(pid).subscribe({
        next: (config) => {
          this.isolationConfigCache.set(pid, config);
          this.browserIsolationConfig.set(config);
        },
        error: () => {
          this.browserIsolationConfig.set({ projectId: pid, mode: 'shared', sharedGlobs: [] });
        },
      });
    });

    effect(() => {
      const wt = this.worktreePath();
      if (wt) {
        void this.actionsState.loadActions(wt);
      }
    });

    effect(() => {
      const pid = this.projectId();
      if (pid) {
        this.todosService.getTodos(pid).subscribe();
      }
    });

    // Push WebSocket session status changes into tab service instantly.
    // Use untracked() for tab reads/writes to avoid infinite effect cycle
    // (updateTabStatus writes _tabs, which would re-trigger this effect).
    effect(() => {
      const sessionStatuses = this.claudeStatusService.sessionStatuses();
      untracked(() => {
        for (const [sessionId, status] of sessionStatuses) {
          this.tabService.updateTabStatus(sessionId, status as Session['status']);
        }
      });
    });

    effect(() => {
      const sessionCompletions = this.claudeStatusService.sessionCompletions();
      untracked(() => {
        for (const [sessionId, completion] of sessionCompletions) {
          if (shouldAutoReviewSessionCompletion(this.activeSessionId(), sessionId, completion.hasUnreviewedCompletion)) {
            const tab = this.tabs().find(currentTab => currentTab.sessionId === sessionId);
            if (tab) {
              this.clearCompletionMarkerFromTab({
                ...tab,
                hasUnreviewedCompletion: completion.hasUnreviewedCompletion,
                lastCompletionAt: completion.lastCompletionAt,
                lastCompletionKind: completion.lastCompletionKind as Session['lastCompletionKind'],
              });
            }
            continue;
          }

          this.tabService.updateTabCompletion(sessionId, {
            hasUnreviewedCompletion: completion.hasUnreviewedCompletion,
            lastCompletionAt: completion.lastCompletionAt,
            lastCompletionKind: completion.lastCompletionKind as Session['lastCompletionKind'],
          });
        }
      });
    });

    // Re-poll all open tabs on WebSocket reconnection to catch missed events
    effect(() => {
      const reconnectCount = this.claudeStatusService.onReconnect();
      if (reconnectCount > 0) {
        untracked(() => {
          const openIds = this.tabService.getOpenSessionIds();
          if (openIds.length > 0) {
            void this.pollSessionStatuses(openIds);
          }
        });
      }
    });

  }

  ngOnInit(): void {
    this.runWhenConnected(() => {
      const urlSessionId = this.getSessionIdFromUrl();
      const saved = this.tabService.getSavedState();

      if (saved && saved.sessionIds.length > 0) {
        this.restoreSavedTabs(saved, urlSessionId);
      } else if (urlSessionId) {
        this.loadAndOpenSession(urlSessionId);
      }
    });

    // Listen for navigation to new sessions
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd),
      takeUntil(this.destroy$)
    ).subscribe(() => {
      const newSessionId = this.getSessionIdFromUrl();
      if (newSessionId) {
        if (!this.tabService.getOpenSessionIds().includes(newSessionId)) {
          // Session not open yet - load from backend
          this.loadAndOpenSession(newSessionId);
        } else {
          // Session already open - just select it
          this.tabService.selectTab(newSessionId);
          const existingTab = this.tabs().find(tab => tab.sessionId === newSessionId);
          if (existingTab) {
            this.clearCompletionMarkerFromTab(existingTab);
          }
        }
      }
    });

    // Start status polling for open tabs
    this.startStatusPolling();

    // Subscribe to plannotator events
    this.plannotatorService.events$
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => this.handlePlannotatorEvent(event));
  }

  private registerOpenWorktrees(): void {
    const tabsList = this.tabs();
    console.log('[SessionContainer] registerOpenWorktrees: tabs count=', tabsList.length, 'tabs=', tabsList.map(t => ({ id: t.sessionId, wt: t.worktreePath })));
    for (const tab of tabsList) {
      if (tab.worktreePath) {
        this.plannotatorService.registerWorktree(tab.worktreePath, tab.sessionId);
      }
    }
  }

  private getWorktreePathForSession(sessionId: number): string | null {
    return this.tabs().find(tab => tab.sessionId === sessionId)?.worktreePath ?? null;
  }

  private getProjectIdForSession(sessionId: number): number | null {
    return this.tabs().find(tab => tab.sessionId === sessionId)?.projectId ?? null;
  }

  private getIframeKeyForSession(sessionId: number): string | null {
    const tab = this.tabs().find(currentTab => currentTab.sessionId === sessionId);
    if (!tab) {
      return null;
    }

    return buildVSCodeIframeKey(tab.projectId, tab.worktreePath);
  }

  private maybeDestroyWorktreeIframe(iframeKey: string | null, worktreePath: string | null, projectId: number | null): void {
    if (!iframeKey || !worktreePath || projectId === null) {
      return;
    }

    const hasRemainingTabs = this.tabs().some(tab => tab.worktreePath === worktreePath && tab.projectId === projectId);
    if (!hasRemainingTabs) {
      this.vscodeWebState.destroyIframe(iframeKey);
    }
  }

  private getBrowserKeyForSession(sessionId: number): string | null {
    const tab = this.tabs().find(currentTab => currentTab.sessionId === sessionId);
    if (!tab) {
      return null;
    }

    return buildBrowserViewProjectPrefix(tab.projectId);
  }

  private maybeDestroyProjectBrowser(browserKey: string | null, projectId: number | null): void {
    if (!browserKey || projectId === null) {
      return;
    }

    const hasRemainingTabs = this.tabs().some(tab => tab.projectId === projectId);
    if (!hasRemainingTabs) {
      const browserKeys = Array.from(this.browserViewState.states().keys()).filter(key => key.startsWith(browserKey));
      this.browserTabsState.removeProject(projectId);
      this.browserViewState.removeStatesByPrefix(browserKey);
      const browserApi = window.__ELEVENEX_ELECTRON__?.browser;
      for (const key of browserKeys) {
        void browserApi?.close(key);
      }
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }

    if (shouldCloseActiveSessionTab(event)) {
      const sessionId = this.activeSessionId();
      if (!sessionId) {
        return;
      }

      event.preventDefault();
      this.onTabClose(sessionId);
      return;
    }

    if (!event.ctrlKey || event.altKey || event.metaKey || event.code !== 'Tab') {
      return;
    }

    const nextSessionId = event.shiftKey
      ? this.tabService.selectPreviousTab()
      : this.tabService.selectNextTab();

    if (!nextSessionId) {
      return;
    }

    event.preventDefault();
    this.router.navigate(['/sessions', nextSessionId], { replaceUrl: true });
  }

  private runWhenConnected(action: () => void): void {
    if (!this.sshRuntimeRecovery.remoteConnecting()) {
      action();
      return;
    }

    const ref = effect(() => {
      if (this.sshRuntimeRecovery.remoteConnecting()) {
        return;
      }
      ref.destroy();
      action();
    }, { injector: this.injector });
  }

  private getSessionIdFromUrl(): number | null {
    const child = this.route.snapshot.firstChild;
    if (child?.routeConfig?.path === ':id') {
      return Number(child.paramMap.get('id'));
    }
    return null;
  }

  private restoreSavedTabs(
    saved: { sessionIds: number[]; activeSessionId: number | null },
    urlSessionId: number | null,
  ): void {
    forkJoin(
      saved.sessionIds.map(id =>
        this.sessionsService.getOne(id).pipe(catchError(() => of(null)))
      )
    ).subscribe(sessions => {
      for (const session of sessions) {
        if (session) {
          this.tabService.openTab(session);
        }
      }

      // URL takes precedence over saved active tab
      const activeId = urlSessionId ?? saved.activeSessionId;
      const openIds = this.tabService.getOpenSessionIds();

      if (activeId && openIds.includes(activeId)) {
        this.tabService.selectTab(activeId);
        this.router.navigate(['/sessions', activeId], { replaceUrl: true });
      } else if (openIds.length > 0) {
        this.tabService.selectTab(openIds[0]);
        this.router.navigate(['/sessions', openIds[0]], { replaceUrl: true });
      }

      // Register worktrees now that tabs are loaded, then catch up on active panels
      this.registerOpenWorktrees();
      this.plannotatorService.requestActivePanels();
    });
  }

  private loadAndOpenSession(id: number): void {
    this.sessionsService.getOne(id).subscribe({
      next: (session) => {
        this.tabService.openTab(session);
        this.clearCompletionMarker(session.id, session);
        if (session.worktreePath) {
          this.plannotatorService.registerWorktree(session.worktreePath, session.id);
        }
        this.plannotatorService.requestActivePanels();
      },
      error: (err) => {
        if (err?.status === 404) {
          toast.error('Session no longer exists');
          this.router.navigate(['/projects']);
        } else {
          toast.error('Failed to load session');
        }
      },
    });
  }

  private clearCompletionMarker(sessionId: number, session: Session): void {
    if (!session.hasUnreviewedCompletion) {
      return;
    }

    this.tabService.updateTabCompletion(sessionId, {
      hasUnreviewedCompletion: false,
      lastCompletionAt: session.lastCompletionAt,
      lastCompletionKind: session.lastCompletionKind,
    });
    this.claudeStatusService.setSessionCompletion(sessionId, {
      hasUnreviewedCompletion: false,
      lastCompletionAt: session.lastCompletionAt,
      lastCompletionKind: session.lastCompletionKind,
      lastStateChangeAt: session.lastStateChangeAt,
    });

    this.sessionsService.markReviewed(sessionId).subscribe({
      next: (updated) => {
        this.tabService.updateTabCompletion(sessionId, {
          hasUnreviewedCompletion: updated.hasUnreviewedCompletion,
          lastCompletionAt: updated.lastCompletionAt,
          lastCompletionKind: updated.lastCompletionKind,
        });
        this.claudeStatusService.setSessionCompletion(sessionId, {
          hasUnreviewedCompletion: updated.hasUnreviewedCompletion,
          lastCompletionAt: updated.lastCompletionAt,
          lastCompletionKind: updated.lastCompletionKind,
          lastStateChangeAt: updated.lastStateChangeAt,
        });
      },
      error: () => {
        this.tabService.updateTabCompletion(sessionId, {
          hasUnreviewedCompletion: session.hasUnreviewedCompletion,
          lastCompletionAt: session.lastCompletionAt,
          lastCompletionKind: session.lastCompletionKind,
        });
        this.claudeStatusService.setSessionCompletion(sessionId, {
          hasUnreviewedCompletion: session.hasUnreviewedCompletion,
          lastCompletionAt: session.lastCompletionAt,
          lastCompletionKind: session.lastCompletionKind,
          lastStateChangeAt: session.lastStateChangeAt,
        });
      },
    });
  }

  private clearCompletionMarkerFromTab(tab: Tab): void {
    if (!tab.hasUnreviewedCompletion) {
      return;
    }

    this.tabService.updateTabCompletion(tab.sessionId, {
      hasUnreviewedCompletion: false,
      lastCompletionAt: tab.lastCompletionAt,
      lastCompletionKind: tab.lastCompletionKind,
    });
    this.claudeStatusService.setSessionCompletion(tab.sessionId, {
      hasUnreviewedCompletion: false,
      lastCompletionAt: tab.lastCompletionAt,
      lastCompletionKind: tab.lastCompletionKind,
      lastStateChangeAt: this.claudeStatusService.getSessionCompletion(tab.sessionId)?.lastStateChangeAt ?? null,
    });

    this.sessionsService.markReviewed(tab.sessionId).subscribe({
      next: (updated) => {
        this.tabService.updateTabCompletion(tab.sessionId, {
          hasUnreviewedCompletion: updated.hasUnreviewedCompletion,
          lastCompletionAt: updated.lastCompletionAt,
          lastCompletionKind: updated.lastCompletionKind,
        });
        this.claudeStatusService.setSessionCompletion(tab.sessionId, {
          hasUnreviewedCompletion: updated.hasUnreviewedCompletion,
          lastCompletionAt: updated.lastCompletionAt,
          lastCompletionKind: updated.lastCompletionKind,
          lastStateChangeAt: updated.lastStateChangeAt,
        });
      },
      error: () => {
        this.tabService.updateTabCompletion(tab.sessionId, {
          hasUnreviewedCompletion: tab.hasUnreviewedCompletion,
          lastCompletionAt: tab.lastCompletionAt,
          lastCompletionKind: tab.lastCompletionKind,
        });
        this.claudeStatusService.setSessionCompletion(tab.sessionId, {
          hasUnreviewedCompletion: tab.hasUnreviewedCompletion,
          lastCompletionAt: tab.lastCompletionAt,
          lastCompletionKind: tab.lastCompletionKind,
          lastStateChangeAt: this.claudeStatusService.getSessionCompletion(tab.sessionId)?.lastStateChangeAt ?? null,
        });
      },
    });
  }

  /**
   * Poll open sessions for status updates every 5 seconds.
   * Keeps tab indicators accurate even if status changes externally.
   */
  private startStatusPolling(): void {
    interval(30000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => {
          const openIds = this.tabService.getOpenSessionIds();
          if (openIds.length === 0) {
            return []; // No open sessions, skip this poll
          }
          // Fetch status for all open sessions in parallel
          return from(this.pollSessionStatuses(openIds));
        })
      )
      .subscribe();
  }

  /**
   * Fetch all open sessions and update tab statuses.
   * If a session no longer exists (404), close its tab.
   */
  private async pollSessionStatuses(openIds: number[]): Promise<void> {
    const results = await Promise.allSettled(
      openIds.map(id => this.sessionsService.getOne(id).toPromise())
    );

    results.forEach((result, index) => {
      const sessionId = openIds[index];

      if (result.status === 'fulfilled' && result.value) {
        this.tabService.updateTabStatus(sessionId, result.value.status);
      } else if (result.status === 'rejected') {
        const error = result.reason;
        if (error?.status === 404) {
          const worktreePath = this.getWorktreePathForSession(sessionId);
          const iframeKey = this.getIframeKeyForSession(sessionId);
          const browserKey = this.getBrowserKeyForSession(sessionId);
          const projectId = this.getProjectIdForSession(sessionId);
          this.tabService.closeTab(sessionId);
          this.maybeDestroyWorktreeIframe(iframeKey, worktreePath, projectId);
          this.maybeDestroyProjectBrowser(browserKey, projectId);
          toast.error(`Session ${sessionId} no longer exists`);
        }
      }
    });

    const activeWorktreePath = this.worktreePath();
    if (activeWorktreePath) {
      await this.actionsState.loadActions(activeWorktreePath);
    }
  }

  onTabSelect(sessionId: number): void {
    this.tabService.selectTab(sessionId);
    // Update URL to reflect active session
    this.router.navigate(['/sessions', sessionId], { replaceUrl: true });
  }

  onTabClose(sessionId: number): void {
    const worktreePath = this.getWorktreePathForSession(sessionId);
    const iframeKey = this.getIframeKeyForSession(sessionId);
    const browserKey = this.getBrowserKeyForSession(sessionId);
    const projectId = this.getProjectIdForSession(sessionId);
    const newActiveId = this.tabService.closeTab(sessionId);
    this.maybeDestroyWorktreeIframe(iframeKey, worktreePath, projectId);
    this.maybeDestroyProjectBrowser(browserKey, projectId);

    // Terminal stays in cache but is hidden via CSS
    // If no tabs left, navigate to projects
    if (!newActiveId) {
      this.router.navigate(['/projects']);
    } else {
      // Switch to new active tab
      this.router.navigate(['/sessions', newActiveId], { replaceUrl: true });
    }

    toast.success('Tab closed (session keeps running)');
  }

  onCloseAllTabs(): void {
    const result = this.tabService.closeAllTabs();
    this.handleBulkTabCloseResult(result);
    toast.success('Closed all tabs');
  }

  onCloseOtherTabs(sessionId: number): void {
    const result = this.tabService.closeOtherTabs(sessionId);
    this.handleBulkTabCloseResult(result);
    if (result.closedSessionIds.length > 0) {
      toast.success('Closed other tabs');
    }
  }

  onCloseTabsToRight(sessionId: number): void {
    const result = this.tabService.closeTabsToRight(sessionId);
    this.handleBulkTabCloseResult(result);
    if (result.closedSessionIds.length > 0) {
      toast.success('Closed tabs to the right');
    }
  }

  onCloseTabsToLeft(sessionId: number): void {
    const result = this.tabService.closeTabsToLeft(sessionId);
    this.handleBulkTabCloseResult(result);
    if (result.closedSessionIds.length > 0) {
      toast.success('Closed tabs to the left');
    }
  }

  onTabDeleteRequest(sessionId: number): void {
    this.deleteTargetSessionId.set(sessionId);
    this.showDeleteDialog.set(true);
  }

  confirmDeleteSession(): void {
    const sessionId = this.deleteTargetSessionId();
    if (!sessionId) return;
    const worktreePath = this.getWorktreePathForSession(sessionId);
    const iframeKey = this.getIframeKeyForSession(sessionId);
    const browserKey = this.getBrowserKeyForSession(sessionId);
    const projectId = this.getProjectIdForSession(sessionId);

    this.sessionsService.delete(sessionId).subscribe({
      next: () => {
        this.showDeleteDialog.set(false);
        this.deleteTargetSessionId.set(null);
        const newActiveId = this.tabService.closeTab(sessionId);
        this.maybeDestroyWorktreeIframe(iframeKey, worktreePath, projectId);
        this.maybeDestroyProjectBrowser(browserKey, projectId);
        if (!newActiveId) {
          this.router.navigate(['/projects']);
        } else {
          this.router.navigate(['/sessions', newActiveId], { replaceUrl: true });
        }
        this.navService.refreshTree();
        toast.success('Session deleted');
      },
      error: (err) => {
        this.showDeleteDialog.set(false);
        this.deleteTargetSessionId.set(null);
        toast.error('Could not delete session. ' + (err.error?.message || ''));
      },
    });
  }

  cancelDeleteSession(): void {
    this.showDeleteDialog.set(false);
    this.deleteTargetSessionId.set(null);
  }

  // Panel toggles
  toggleScratchpad(): void {
    const pid = this.projectId();
    if (pid) {
      this.productivityState.togglePanel(pid, 'scratchpad');
    }
  }

  toggleTodos(): void {
    const pid = this.projectId();
    if (pid) {
      this.productivityState.togglePanel(pid, 'todos');
    }
  }

  private handlePlannotatorEvent(event: PlannotatorEvent | unknown): void {
    console.log('[SessionContainer] handlePlannotatorEvent called with:', JSON.stringify(event));

    if (!event || typeof event !== 'object' || !('type' in event)) {
      console.log('[SessionContainer] Event rejected: invalid shape');
      return;
    }

    const plannotatorEvent = event as PlannotatorEvent;

    if (plannotatorEvent.type === 'url-received') {
      const { proxyUrl, sessionId, upstreamPort } = plannotatorEvent;

      console.log('[SessionContainer] url-received: proxyUrl=', proxyUrl, 'sessionId=', sessionId, 'upstreamPort=', upstreamPort);
      console.log('[SessionContainer] activeSessionId=', this.activeSessionId(), 'tabs=', this.tabs().map(t => ({ id: t.sessionId, wt: t.worktreePath })));

      const targetSessionId = sessionId;

      if (targetSessionId && proxyUrl) {
        let mode: 'plan' | 'review' | 'annotate' | 'archive' = 'plan';
        try {
          const parsed = new URL(proxyUrl, getBackendOrigin());
          const queryMode = parsed.searchParams.get('mode');
          if (
            queryMode === 'plan'
            || queryMode === 'review'
            || queryMode === 'annotate'
            || queryMode === 'archive'
          ) {
            mode = queryMode;
          } else if (parsed.pathname.includes('/review')) {
            mode = 'review';
          } else if (parsed.pathname.includes('/annotate')) {
            mode = 'annotate';
          } else if (parsed.pathname.includes('/archive')) {
            mode = 'archive';
          }
        } catch {
          // Ignore malformed URLs and keep the default mode.
        }

        // Prepend backend origin so the iframe targets the backend proxy, not the frontend
        const absoluteProxyUrl = proxyUrl.startsWith('/') ? `${getBackendOrigin()}${proxyUrl}` : proxyUrl;

        console.log('[SessionContainer] Opening panel: targetSessionId=', targetSessionId, 'mode=', mode);
        this.plannotatorState.openPanel(targetSessionId, absoluteProxyUrl, upstreamPort, mode);

        console.log('[SessionContainer] Panel opened. showPlannotator=', this.showPlannotator(), 'activePlannotatorPanel=', JSON.stringify(this.activePlannotatorPanel()));
        if (targetSessionId !== this.activeSessionId()) {
          const tab = this.tabs().find(t => t.sessionId === targetSessionId);
          const projectName = tab
            ? this.navService.tree().find(p => p.id === tab.projectId)?.name
            : undefined;
          const label = projectName
            ? `${projectName} / ${tab!.branchName} / ${tab!.sessionName}`
            : tab ? `${tab.branchName} / ${tab.sessionName}` : `Session ${targetSessionId}`;
          toast.info(`Review waiting in ${label}`);
        }
      } else {
        console.log('[SessionContainer] NOT opening panel: targetSessionId=', targetSessionId, 'proxyUrl=', proxyUrl);
      }
    } else if (plannotatorEvent.type === 'close') {
      if (plannotatorEvent.sessionId) {
        this.plannotatorState.closePanel(plannotatorEvent.sessionId);
      }
    } else {
      console.log('[SessionContainer] Ignoring event type:', (event as any).type);
    }
  }

  closeTerminalPanel(): void {
    const wt = this.worktreePath();
    if (wt) {
      this.userTerminalState.setPanelOpen(wt, false);
    }
  }

  closeActionsPanel(): void {
    const wt = this.worktreePath();
    if (wt) {
      this.actionsState.setPanelOpen(wt, false);
    }
  }

  private handleBulkTabCloseResult(result: TabCloseResult): void {
    for (const sessionId of result.closedSessionIds) {
      const worktreePath = this.getWorktreePathForSession(sessionId);
      const iframeKey = this.getIframeKeyForSession(sessionId);
      const browserKey = this.getBrowserKeyForSession(sessionId);
      const projectId = this.getProjectIdForSession(sessionId);
      this.maybeDestroyWorktreeIframe(iframeKey, worktreePath, projectId);
      this.maybeDestroyProjectBrowser(browserKey, projectId);
    }

    if (!result.activeSessionId) {
      this.router.navigate(['/projects']);
      return;
    }

    this.router.navigate(['/sessions', result.activeSessionId], { replaceUrl: true });
  }

  closePlannotatorPanel(): void {
    const sessionId = this.activeSessionId();
    if (sessionId) {
      this.plannotatorState.closePanel(sessionId);
      this.plannotatorService.closePanel(sessionId);
    }
  }

  softClosePlannotatorPanel(): void {
    const sessionId = this.activeSessionId();
    if (sessionId) {
      this.plannotatorState.closePanel(sessionId);
    }
  }

  minimizePlannotatorPanel(): void {
    const sessionId = this.activeSessionId();
    if (sessionId) {
      this.plannotatorState.minimizePanel(sessionId);
    }
  }

  restorePlannotatorPanel(): void {
    const sessionId = this.activeSessionId();
    if (sessionId) {
      this.plannotatorState.restorePanel(sessionId);
    }
  }
}
