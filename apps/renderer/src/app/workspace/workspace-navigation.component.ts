import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, inject } from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { ProjectMenuComponent, type ProjectMenuAction } from '../projects';
import { StatusSummaryComponent, TaskGroupComponent, TaskListComponent, type TaskSession } from '../tasks';
import { ButtonComponent, IconButtonComponent, IconComponent, TooltipDirective } from '../ui';
import { SidebarPreferencesService } from './sidebar-preferences.service';
import { WorkspaceStore } from './workspace.store';

@Component({
  selector: 'ex-workspace-navigation',
  imports: [StatusSummaryComponent, TaskListComponent, TaskGroupComponent, ButtonComponent, IconButtonComponent, IconComponent, TooltipDirective, CdkMenuTrigger, ProjectMenuComponent],
  templateUrl: './workspace-navigation.component.html',
  styleUrl: './workspace-navigation.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceNavigationComponent {
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly destroy = inject(DestroyRef);
  private restoreFocusFrame?: number;
  constructor() {
    this.destroy.onDestroy(() => { if (this.restoreFocusFrame !== undefined) cancelAnimationFrame(this.restoreFocusFrame); });
  }
  protected readonly preferences = inject(SidebarPreferencesService);
  protected readonly store = inject(WorkspaceStore);
  // The main setup surface owns this actionable failure; avoid announcing it twice.
  protected readonly visibleError = computed(() => (this.store.pendingTask()?.setupIssue?.message === this.store.error() ? null : this.store.error()) ?? this.store.resumeError());
  protected readonly label = computed(() => this.store.selectedProject()?.name ?? 'All projects');
  protected readonly projectMark = computed(() => this.store.projects().find(project => project.id === this.store.activeProject()));
  protected async archiveSession(intent: { readonly taskId: string; readonly session: TaskSession }): Promise<void> {
    const origin = this.root.ownerDocument.activeElement, scope = this.store.scopeId();
    await this.store.archiveSession(intent);
    if (this.destroy.destroyed || this.store.scopeId() !== scope || this.store.sessionArchiveUndo()?.session.id !== Number(intent.session.id)) return;
    afterNextRender(() => {
      const document = this.root.ownerDocument;
      if (document.activeElement !== origin && document.activeElement !== document.body) return;
      const taskId = Number(intent.taskId), selected = this.store.selected();
      const row = selected?.taskId === taskId ? this.root.querySelector<HTMLButtonElement>(`[data-task-id="${taskId}"] [data-session-id="${selected.sessionId}"] .select`) : null;
      (row ?? this.root.querySelector<HTMLButtonElement>(`[data-task-id="${taskId}"] header .toggle`))?.focus({ preventScroll: true });
    }, { injector: this.injector });
  }
  protected async restoreSession(intent: { readonly taskId: string; readonly session: TaskSession }): Promise<void> {
    const scope = this.store.scopeId(), origin = this.root.ownerDocument.activeElement;
    await this.store.restoreSession(intent);
    if (this.destroy.destroyed || this.store.scopeId() !== scope || this.store.busy() || this.store.error()) return;
    afterNextRender(() => {
      if (this.restoreFocusFrame !== undefined) cancelAnimationFrame(this.restoreFocusFrame);
      let remainingFrames = 4;
      const focus = () => {
        this.restoreFocusFrame = undefined;
        const document = this.root.ownerDocument;
        if (this.destroy.destroyed || this.store.scopeId() !== scope || (document.activeElement !== origin && document.activeElement !== document.body)) return;
        const row = this.root.querySelector<HTMLButtonElement>(`[data-task-id="${Number(intent.taskId)}"] .tree > ex-fold [data-session-id="${Number(intent.session.id)}"] .select`);
        if (row && !row.closest('[inert]')) { row.focus({ preventScroll: true }); return; }
        // ListPresence establishes the new row closed before opening it on the next paint.
        if (remainingFrames-- > 0) this.restoreFocusFrame = requestAnimationFrame(focus);
      };
      focus();
    }, { injector: this.injector });
  }
  protected projectAction(action: ProjectMenuAction): void {
    if (action === 'settings') void this.store.openSettings();
    if (action === 'add-repository') void this.store.openSettings(true);
    if (action === 'closed-tasks') void this.store.showClosed(true);
    if (action === 'archive') void this.store.archiveProject();
    if (action === 'delete') this.store.requestDeleteProject();
  }
}
