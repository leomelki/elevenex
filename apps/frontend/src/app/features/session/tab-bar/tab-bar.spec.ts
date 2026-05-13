import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TabBar } from './tab-bar';
import { ClaudeStatusService } from '../../../shared/services/claude-status.service';
import { ProductivityStateService } from '../../productivity/productivity-state.service';
import { PlannotatorStateService } from '../../plannotator';
import { GitHubStateService } from '../../github/github-state.service';
import { Tab } from '../tab-service';
import { AgentRuntimeProviderService } from '@/shared/services/agent-runtime-provider.service';
import { signal } from '@angular/core';

describe('TabBar', () => {
  const claudeStatusMock = {
    getStatus: vi.fn(() => 'idle'),
    getSessionCompletion: vi.fn(() => null),
  };

  const productivityStateMock = {
    states: vi.fn(() => new Map()),
  };

  const plannotatorStateMock = {
    isPanelVisible: vi.fn(() => false),
  };

  const githubStateMock = {
    hasLinkedPullRequest: vi.fn(() => false),
  };

  const providerSelectionMock = {
    selectedProvider: signal('claude'),
  };

  const baseTab: Tab = {
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
    activeAgentProvider: 'claude',
    hasStartedAgentRuntime: false,
  };

  beforeEach(async () => {
    claudeStatusMock.getStatus.mockReturnValue('idle');
    claudeStatusMock.getSessionCompletion.mockReturnValue(null);
    plannotatorStateMock.isPanelVisible.mockReturnValue(false);

    await TestBed.configureTestingModule({
      imports: [TabBar],
      providers: [
        { provide: ClaudeStatusService, useValue: claudeStatusMock },
        { provide: ProductivityStateService, useValue: productivityStateMock },
        { provide: PlannotatorStateService, useValue: plannotatorStateMock },
        { provide: GitHubStateService, useValue: githubStateMock },
        { provide: AgentRuntimeProviderService, useValue: providerSelectionMock },
      ],
    }).compileComponents();
  });

  it('shows the completion badge when a tab has unreviewed completion', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [{ ...baseTab, hasUnreviewedCompletion: true }]);
    fixture.componentRef.setInput('activeSessionId', 42);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.completion-indicator')).toBeTruthy();
  });

  it('shows live status dot and completion badge independently', () => {
    claudeStatusMock.getStatus.mockReturnValue('running');
    plannotatorStateMock.isPanelVisible.mockReturnValue(true);

    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [{ ...baseTab, hasUnreviewedCompletion: true }]);
    fixture.componentRef.setInput('activeSessionId', 42);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.status-running')).toBeTruthy();
    expect(el.querySelector('.completion-indicator')).toBeTruthy();
    expect(el.querySelector('.review-indicator')).toBeTruthy();
  });

  it('renders bulk close actions in the context menu', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [
      { ...baseTab, sessionId: 1 },
      { ...baseTab, sessionId: 2, sessionName: 'Session 2' },
      { ...baseTab, sessionId: 3, sessionName: 'Session 3' },
    ]);
    fixture.componentRef.setInput('activeSessionId', 2);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const tab = el.querySelector('.tab') as HTMLElement;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
    fixture.detectChanges();

    const menuText = el.textContent ?? '';
    expect(menuText).toContain('Close Other Tabs');
    expect(menuText).toContain('Close Tabs to the Right');
    expect(menuText).toContain('Close Tabs to the Left');
    expect(menuText).toContain('Close All Tabs');
  });

  it('shows archive or unarchive actions based on tab status', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [
      { ...baseTab, sessionId: 1, status: 'active' },
      { ...baseTab, sessionId: 2, sessionName: 'Archived', status: 'archived' },
    ]);
    fixture.componentRef.setInput('activeSessionId', 1);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const tabs = el.querySelectorAll('.tab');

    (tabs[0] as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(el.textContent).toContain('Archive Session');
    expect(el.textContent).not.toContain('Unarchive Session');

    (tabs[1] as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(el.textContent).toContain('Unarchive Session');
  });

  it('emits archive and unarchive events from the context menu', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [
      { ...baseTab, sessionId: 1, status: 'active' },
      { ...baseTab, sessionId: 2, sessionName: 'Archived', status: 'archived' },
    ]);
    fixture.componentRef.setInput('activeSessionId', 1);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    const archiveSpy = vi.fn();
    const unarchiveSpy = vi.fn();
    component.tabArchive.subscribe(archiveSpy);
    component.tabUnarchive.subscribe(unarchiveSpy);

    const el = fixture.nativeElement as HTMLElement;
    const tabs = el.querySelectorAll('.tab');

    (tabs[0] as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('Archive Session')) as HTMLButtonElement).click();
    expect(archiveSpy).toHaveBeenCalledWith(1);

    (tabs[1] as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('Unarchive Session')) as HTMLButtonElement).click();
    expect(unarchiveSpy).toHaveBeenCalledWith(2);
  });

  it('hides active-session tool buttons for archived tabs', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [{ ...baseTab, status: 'archived' }]);
    fixture.componentRef.setInput('activeSessionId', 42);
    fixture.componentRef.setInput('projectId', 10);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-label="Toggle Terminal panel"]')).toBeNull();
  });

  it('shows the plannotator toolbar button only when plannotator is available', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [{ ...baseTab }]);
    fixture.componentRef.setInput('activeSessionId', 42);
    fixture.componentRef.setInput('projectId', 10);
    fixture.componentRef.setInput('plannotatorAvailable', false);
    fixture.detectChanges();

    let el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-label="Toggle Plannotator panel"]')).toBeNull();

    fixture.componentRef.setInput('plannotatorAvailable', true);
    fixture.detectChanges();

    el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-label="Toggle Plannotator panel"]')).toBeTruthy();
  });

  it('disables left and other actions appropriately for the first tab', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [
      { ...baseTab, sessionId: 1 },
      { ...baseTab, sessionId: 2, sessionName: 'Session 2' },
    ]);
    fixture.componentRef.setInput('activeSessionId', 1);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const firstTab = el.querySelector('.tab') as HTMLElement;
    firstTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    const buttons = Array.from(el.querySelectorAll('button'));
    const closeOther = buttons.find(button => button.textContent?.includes('Close Other Tabs')) as HTMLButtonElement;
    const closeRight = buttons.find(button => button.textContent?.includes('Close Tabs to the Right')) as HTMLButtonElement;
    const closeLeft = buttons.find(button => button.textContent?.includes('Close Tabs to the Left')) as HTMLButtonElement;

    expect(closeOther.disabled).toBe(false);
    expect(closeRight.disabled).toBe(false);
    expect(closeLeft.disabled).toBe(true);
  });

  it('emits bulk close events from the context menu', () => {
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [
      { ...baseTab, sessionId: 1 },
      { ...baseTab, sessionId: 2, sessionName: 'Session 2' },
      { ...baseTab, sessionId: 3, sessionName: 'Session 3' },
    ]);
    fixture.componentRef.setInput('activeSessionId', 2);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    const closeOtherTabsSpy = vi.fn();
    const closeTabsToRightSpy = vi.fn();
    const closeTabsToLeftSpy = vi.fn();
    const closeAllTabsSpy = vi.fn();
    component.closeOtherTabs.subscribe(closeOtherTabsSpy);
    component.closeTabsToRight.subscribe(closeTabsToRightSpy);
    component.closeTabsToLeft.subscribe(closeTabsToLeftSpy);
    component.closeAllTabs.subscribe(closeAllTabsSpy);

    const el = fixture.nativeElement as HTMLElement;
    const middleTab = el.querySelectorAll('.tab')[1] as HTMLElement;

    middleTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('Close Other Tabs')) as HTMLButtonElement).click();
    expect(closeOtherTabsSpy).toHaveBeenCalledWith(2);

    middleTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('Close Tabs to the Right')) as HTMLButtonElement).click();
    expect(closeTabsToRightSpy).toHaveBeenCalledWith(2);

    middleTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('Close Tabs to the Left')) as HTMLButtonElement).click();
    expect(closeTabsToLeftSpy).toHaveBeenCalledWith(2);

    middleTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('Close All Tabs')) as HTMLButtonElement).click();
    expect(closeAllTabsSpy).toHaveBeenCalledOnce();
  });
});
