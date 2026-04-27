import { Component, output, input, inject, computed, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX, lucideCircle, lucideCircleDashed, lucideFileText, lucideCheckSquare, lucideFolderTree, lucideTerminal, lucideTrash2, lucideMessageSquare, lucideGlobe, lucidePlay, lucideGitPullRequest, lucideCheck } from '@ng-icons/lucide';
import { Tab } from '../tab-service';
import { TabColorService } from '../../../shared/services/tab-color.service';
import { ProductivityStateService } from '@/features/productivity/productivity-state.service';
import { PlannotatorStateService } from '@/features/plannotator';
import { ClaudeStatusService, ClaudeActivityStatus } from '@/shared/services/claude-status.service';
import { GitHubStateService } from '@/features/github/github-state.service';
import { CommitButtonComponent } from '@/features/git/commit-button.component';

@Component({
  selector: 'app-tab-bar',
  standalone: true,
  imports: [CommonModule, NgIcon, CommitButtonComponent],
  templateUrl: './tab-bar.html',
  styleUrls: ['./tab-bar.scss'],
  viewProviders: [
    provideIcons({
      lucideX,
      lucideCircle,
      lucideCircleDashed,
      lucideFileText,
      lucideCheckSquare,
      lucideFolderTree,
      lucideTerminal,
      lucideTrash2,
      lucideMessageSquare,
      lucideGlobe,
      lucidePlay,
      lucideGitPullRequest,
      lucideCheck,
    }),
  ],
})
export class TabBar {
  private colorService = inject(TabColorService);
  private productivityState = inject(ProductivityStateService);
  private plannotatorState = inject(PlannotatorStateService);
  private claudeStatusService = inject(ClaudeStatusService);
  private githubState = inject(GitHubStateService);

  tabs = input.required<Tab[]>();
  activeSessionId = input.required<number | null>();
  projectId = input<number | null>(null);
  worktreePath = input<string | null>(null);

  showFiles = input(false);
  showBrowser = input(false);
  showGithub = input(false);
  showTerminal = input(false);
  showActions = input(false);
  showClaudeTerminalFallback = input(false);
  runningActionsCount = input(0);
  pendingTodosCount = input(0);

  tabSelect = output<number>();
  tabClose = output<number>();
  tabDelete = output<number>();
  closeAllTabs = output<void>();
  closeOtherTabs = output<number>();
  closeTabsToRight = output<number>();
  closeTabsToLeft = output<number>();
  toggleScratchpad = output<void>();
  toggleTodos = output<void>();
  toggleFiles = output<void>();
  toggleBrowser = output<void>();
  toggleGithub = output<void>();
  toggleTerminal = output<void>();
  toggleActions = output<void>();
  toggleClaudeTerminalFallback = output<void>();

  // Context menu state
  contextMenuOpen = signal(false);
  contextMenuSessionId = signal<number | null>(null);
  contextMenuPosition = signal({ x: 0, y: 0 });

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

  isActive(tab: Tab): boolean {
    return tab.sessionId === this.activeSessionId();
  }

  getStatusClass(status: Tab['status']): string {
    switch (status) {
      case 'active':
      case 'created':
        return 'status-running';
      case 'stopped':
        return 'status-stopped';
      case 'archived':
        return 'status-archived';
      default:
        return '';
    }
  }

  shouldShowStatusIndicator(status: Tab['status']): boolean {
    // Show indicator for active/created (running) and stopped
    // Don't show for archived (use opacity instead)
    return status === 'active' || status === 'created' || status === 'stopped';
  }

  isRunning(status: Tab['status']): boolean {
    return status === 'active' || status === 'created';
  }

  hasReview(tab: Tab): boolean {
    return this.plannotatorState.isPanelVisible(tab.sessionId);
  }

  hasLinkedPullRequest(tab: Tab): boolean {
    return this.githubState.hasLinkedPullRequest(tab.worktreePath);
  }

  getClaudeStatus(tab: Tab): ClaudeActivityStatus {
    return this.claudeStatusService.getStatus(tab.sessionId);
  }

  hasUnreviewedCompletion(tab: Tab): boolean {
    const liveState = this.claudeStatusService.getSessionCompletion(tab.sessionId);
    return liveState?.hasUnreviewedCompletion ?? tab.hasUnreviewedCompletion;
  }

  /**
   * Get the repo color for a tab.
   */
  getRepoColor(tab: Tab): string {
    return this.colorService.getRepoColor(tab.repoId, tab.repoColor);
  }

  /**
   * Check if this tab is from the same project as the active tab.
   */
  isSameProjectAsActive(tab: Tab): boolean {
    const activeId = this.activeSessionId();
    if (!activeId) return false;
    const activeTab = this.tabs().find(t => t.sessionId === activeId);
    if (!activeTab) return false;
    return tab.projectId === activeTab.projectId && tab.sessionId !== activeId;
  }

  /**
   * Generate tooltip text showing full context.
   */
  getTooltip(tab: Tab): string {
    const status = tab.status.charAt(0).toUpperCase() + tab.status.slice(1);
    return `${tab.sessionName}\nBranch: ${tab.branchName}\nStatus: ${status}`;
  }

  onTabClick(tab: Tab): void {
    if (!this.isActive(tab)) {
      this.tabSelect.emit(tab.sessionId);
    }
  }

  onCloseClick(event: MouseEvent, sessionId: number): void {
    event.stopPropagation(); // Prevent tab selection
    this.tabClose.emit(sessionId);
  }

  onContextMenu(event: MouseEvent, tab: Tab): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.contextMenuSessionId.set(tab.sessionId);
    this.contextMenuOpen.set(true);
  }

  closeContextMenu(): void {
    this.contextMenuOpen.set(false);
    this.contextMenuSessionId.set(null);
  }

  canCloseOtherTabs(): boolean {
    return this.tabs().length > 1;
  }

  canCloseTabsToLeft(): boolean {
    const sessionId = this.contextMenuSessionId();
    if (!sessionId) return false;
    return this.tabs().findIndex(tab => tab.sessionId === sessionId) > 0;
  }

  canCloseTabsToRight(): boolean {
    const sessionId = this.contextMenuSessionId();
    if (!sessionId) return false;
    const index = this.tabs().findIndex(tab => tab.sessionId === sessionId);
    return index !== -1 && index < this.tabs().length - 1;
  }

  onContextMenuClose(): void {
    const sessionId = this.contextMenuSessionId();
    this.closeContextMenu();
    if (sessionId) this.tabClose.emit(sessionId);
  }

  onContextMenuDelete(): void {
    const sessionId = this.contextMenuSessionId();
    this.closeContextMenu();
    if (sessionId) this.tabDelete.emit(sessionId);
  }

  onContextMenuCloseAll(): void {
    this.closeContextMenu();
    this.closeAllTabs.emit();
  }

  onContextMenuCloseOtherTabs(): void {
    const sessionId = this.contextMenuSessionId();
    if (!sessionId || !this.canCloseOtherTabs()) return;
    this.closeContextMenu();
    this.closeOtherTabs.emit(sessionId);
  }

  onContextMenuCloseTabsToRight(): void {
    const sessionId = this.contextMenuSessionId();
    if (!sessionId || !this.canCloseTabsToRight()) return;
    this.closeContextMenu();
    this.closeTabsToRight.emit(sessionId);
  }

  onContextMenuCloseTabsToLeft(): void {
    const sessionId = this.contextMenuSessionId();
    if (!sessionId || !this.canCloseTabsToLeft()) return;
    this.closeContextMenu();
    this.closeTabsToLeft.emit(sessionId);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.contextMenuOpen()) {
      this.closeContextMenu();
    }
  }

  trackBySessionId(index: number, tab: Tab): number {
    return tab.sessionId;
  }
}
