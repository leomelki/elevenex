import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { SessionContainer } from './session-container';
import { TabService, type Tab } from '../tab-service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { NavigationService } from '../../../shared/services/navigation.service';
import { ProductivityStateService } from '@/features/productivity/productivity-state.service';
import { PlannotatorService, PlannotatorStateService } from '@/features/plannotator';
import { ActionsStateService } from '@/features/actions';
import { TodosService } from '@/features/productivity/todos.service';
import { UserTerminalStateService } from '@/features/user-terminal';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { BrowserViewStateService } from '@/features/browser-panel/browser-view-state.service';
import { BrowserTabsStateService } from '@/features/browser-panel/browser-tabs-state.service';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { ModalOverlayStateService } from '@/shared/services/modal-overlay-state.service';

describe('SessionContainer modal browser gating', () => {
  const tabsSignal = signal<Tab[]>([]);
  const activeSessionIdSignal = signal<number | null>(null);
  const plannotatorPanelSignal = signal<any>(null);
  const modalActiveSignal = signal(false);
  const claudeStatusesSignal = signal(new Map<number, string>());
  const claudeCompletionsSignal = signal(new Map<number, any>());
  const claudeTitlesSignal = signal(new Map<number, string>());
  const reconnectSignal = signal(0);

  const tabServiceMock = {
    tabs: tabsSignal.asReadonly(),
    activeSessionId: activeSessionIdSignal.asReadonly(),
    hasTabs: () => tabsSignal().length > 0,
    activeTab: () => tabsSignal().find(tab => tab.sessionId === activeSessionIdSignal()) ?? null,
    updateTabStatus: vi.fn(),
    updateTabCompletion: vi.fn(),
    updateTabName: vi.fn(),
    getOpenSessionIds: vi.fn(() => []),
    getSavedState: vi.fn(() => null),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    selectPreviousTab: vi.fn(() => null),
    selectNextTab: vi.fn(() => null),
  };

  const sessionsServiceMock = {
    getOne: vi.fn(() => of(null)),
    markReviewed: vi.fn(() => of(null)),
  };

  const navigationServiceMock = {};

  const productivityStateMock = {
    states: signal(new Map<number, { scratchpad: boolean; todos: boolean }>()),
  };

  const plannotatorServiceMock = {
    events$: new Subject<any>(),
    registerWorktree: vi.fn(),
    requestActivePanels: vi.fn(),
  };

  const plannotatorStateMock = {
    isPanelVisible: vi.fn(() => false),
    getPanel: vi.fn(() => plannotatorPanelSignal()),
  };

  const actionsStateMock = {
    isPanelOpen: vi.fn(() => false),
    getRunningCount: vi.fn(() => 0),
    loadActions: vi.fn(() => Promise.resolve()),
    setPanelOpen: vi.fn(),
  };

  const todosServiceMock = {
    pendingCountsSignal: signal(new Map<number, number>()),
    getPendingCount: vi.fn(() => 0),
    getTodos: vi.fn(() => of([])),
  };

  const userTerminalStateMock = {
    isPanelOpen: vi.fn(() => false),
    setPanelOpen: vi.fn(),
  };

  const vscodeWebStateMock = {
    destroyIframe: vi.fn(),
  };

  const browserViewStateMock = {
    states: signal(new Map<string, any>()),
    removeStatesByPrefix: vi.fn(),
  };

  const browserTabsStateMock = {
    removeProject: vi.fn(),
  };

  const browserIsolationServiceMock = {
    get: vi.fn(() => of({ projectId: 10, mode: 'shared', sharedGlobs: [] })),
  };

  const claudeStatusServiceMock = {
    sessionStatuses: claudeStatusesSignal.asReadonly(),
    sessionCompletions: claudeCompletionsSignal.asReadonly(),
    sessionTitles: claudeTitlesSignal.asReadonly(),
    onReconnect: reconnectSignal.asReadonly(),
    setSessionCompletion: vi.fn(),
  };

  const modalOverlayStateMock = {
    hasOpenModal: modalActiveSignal.asReadonly(),
  };

  beforeEach(async () => {
    tabsSignal.set([
      {
        sessionId: 42,
        sessionName: 'Session 42',
        branchName: 'main',
        worktreePath: '/tmp/main',
        status: 'active',
        hasUnreviewedCompletion: false,
        lastCompletionAt: null,
        lastCompletionKind: null,
        hasInjectedWorktreeContext: false,
        repoId: 1,
        projectId: 10,
        repoColor: null,
      },
    ]);
    activeSessionIdSignal.set(42);
    plannotatorPanelSignal.set(null);
    modalActiveSignal.set(false);
    claudeStatusesSignal.set(new Map());
    claudeCompletionsSignal.set(new Map());
    claudeTitlesSignal.set(new Map());
    reconnectSignal.set(0);
    vi.clearAllMocks();

    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => JSON.stringify({ sidePanelMode: 'browser' }),
        setItem: vi.fn(),
      },
      configurable: true,
    });

    TestBed.overrideComponent(SessionContainer, {
      set: {
        template: `
          @if (shouldRenderBrowserPanel()) {
            <div class="browser-panel-live">live browser</div>
          }
          @if (shouldShowBrowserPlaceholder()) {
            <div class="browser-panel-placeholder">focus mode</div>
          }
        `,
      },
    });

    await TestBed.configureTestingModule({
      imports: [SessionContainer],
      providers: [
        provideRouter([]),
        { provide: TabService, useValue: tabServiceMock },
        { provide: SessionsService, useValue: sessionsServiceMock },
        { provide: NavigationService, useValue: navigationServiceMock },
        { provide: ProductivityStateService, useValue: productivityStateMock },
        { provide: PlannotatorService, useValue: plannotatorServiceMock },
        { provide: PlannotatorStateService, useValue: plannotatorStateMock },
        { provide: ActionsStateService, useValue: actionsStateMock },
        { provide: TodosService, useValue: todosServiceMock },
        { provide: UserTerminalStateService, useValue: userTerminalStateMock },
        { provide: VSCodeWebStateService, useValue: vscodeWebStateMock },
        { provide: BrowserViewStateService, useValue: browserViewStateMock },
        { provide: BrowserTabsStateService, useValue: browserTabsStateMock },
        { provide: BrowserIsolationService, useValue: browserIsolationServiceMock },
        { provide: ClaudeStatusService, useValue: claudeStatusServiceMock },
        { provide: ModalOverlayStateService, useValue: modalOverlayStateMock },
      ],
    }).compileComponents();
  });

  it('shows the live browser panel when no modal is open', () => {
    const fixture = TestBed.createComponent(SessionContainer);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.browser-panel-live')).toBeTruthy();
    expect(element.querySelector('.browser-panel-placeholder')).toBeNull();
  });

  it('switches to the browser placeholder while a modal is open and restores after close', () => {
    const fixture = TestBed.createComponent(SessionContainer);
    fixture.detectChanges();

    modalActiveSignal.set(true);
    fixture.detectChanges();

    let element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.browser-panel-placeholder')).toBeTruthy();
    expect(element.querySelector('.browser-panel-live')).toBeNull();

    modalActiveSignal.set(false);
    fixture.detectChanges();

    element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.browser-panel-live')).toBeTruthy();
    expect(element.querySelector('.browser-panel-placeholder')).toBeNull();
  });

  it('mirrors generated session titles into open tabs', () => {
    const fixture = TestBed.createComponent(SessionContainer);
    fixture.detectChanges();

    claudeTitlesSignal.set(new Map([[42, 'Implement Auto Names']]));
    fixture.detectChanges();

    expect(tabServiceMock.updateTabName).toHaveBeenCalledWith(42, 'Implement Auto Names');
  });
});
