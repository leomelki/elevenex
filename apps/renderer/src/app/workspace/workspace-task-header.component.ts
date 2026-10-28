import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommitPanelComponent, CloseTaskComponent, TaskHeaderComponent, type CommitIntent, type CommitFileProvider, type CloseTaskIntent, type GitAction, type TaskStage } from '../tasks';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, ModalLayerComponent, SetFieldComponent } from '../ui';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskGitService } from './workspace-task-git.service';

@Component({
  selector: 'ex-workspace-task-header',
  imports: [CommitPanelComponent, TaskHeaderComponent, CloseTaskComponent, ButtonComponent, ModalLayerComponent, SetFieldComponent],
  providers: [WorkspaceTaskGitService],
  templateUrl: './workspace-task-header.component.html',
  styleUrl: './workspace-task-header.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceTaskHeaderComponent {
  protected readonly store = inject(WorkspaceStore);
  protected readonly git = inject(WorkspaceTaskGitService);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  readonly panelOpen = input(false);
  readonly panelToggle = output<void>();
  protected readonly copied = signal(false);
  protected readonly closing = signal(false);
  protected readonly closeLoading = signal(false);
  protected readonly closeBusy = signal(false);
  protected readonly closeError = signal<string | null>(null);
  protected readonly commitOpen = signal(false);
  protected readonly pushAfter = signal(false);
  protected readonly commitProvider = computed<CommitFileProvider | undefined>(() => {
    const selected = this.store.selected();
    if (!selected) return undefined;
    const scopeId = selected.scopeId, taskId = selected.taskId, available = this.store.commitPanelAvailable();
    return async (query, signal) => {
      if (!available) throw new Error('Update this machine’s engine to use the commit panel.');
      const result = await this.bridge.workspaceCommitPreview(scopeId, { taskId, ...query });
      if (signal.aborted || this.store.selected()?.scopeId !== scopeId || this.store.selected()?.taskId !== taskId) throw new Error('The selected task changed.');
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
  });
  protected readonly gitDialogOpen = signal(false);
  protected readonly gitDraft = signal('');
  private dialogTask?: number;
  protected readonly confirmingTask = signal<{ readonly id: number; readonly title: string; readonly sessions: number; readonly running: number; readonly unpushed: number; readonly uncommitted?: number; readonly terminals: number; readonly actions: number } | null>(null);
  protected readonly project = computed(() => this.store.projects().find(project => project.id === String(this.store.selectedTask()?.projectId)));
  protected readonly repo = computed(() => {
    const task = this.store.selectedTask();
    return task?.projectRepositoryCount === 1 ? undefined : task?.repoName;
  });
  private resetTimer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private readonly taskKey = computed(() => { const selected = this.store.selected(); return selected ? `${selected.scopeId}/${selected.taskId}` : ''; });
  constructor() {
    effect(() => {
      this.taskKey(); this.epoch++;
      this.copied.set(false); this.gitDialogOpen.set(false); this.commitOpen.set(false); this.closing.set(false); this.closeLoading.set(false); clearTimeout(this.resetTimer);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.resetTimer));
  }

  protected stage(stage: TaskStage): void { if (stage === 'closed') this.close(); else void this.store.setStage(stage); }
  protected async close(): Promise<void> {
    const task = this.store.selectedTask(), selection = this.store.selected(), epoch = this.epoch;
    if (!task || !selection || this.store.busy() || this.closeLoading()) return;
    this.closeLoading.set(true); this.closeError.set(null);
    try {
      const preview = await this.bridge.workspaceClosePreview(selection.scopeId, task.id);
      if (epoch !== this.epoch || this.taskKey() !== `${selection.scopeId}/${task.id}`) return;
      if (preview.ok) {
        const value = preview.value;
        if (!value.running && !value.terminals && !value.actions && !value.unpushed && value.uncommitted === 0) await this.store.closeTask();
        else { this.confirmingTask.set({ id: task.id, title: task.name, ...value }); this.closing.set(true); }
      }
      else this.store.error.set(preview.error.message);
    } catch { if (epoch === this.epoch) this.store.error.set('The task could not be checked before closing.'); }
    finally { if (epoch === this.epoch) this.closeLoading.set(false); }
  }
  protected async confirmClose(intent: CloseTaskIntent): Promise<void> {
    if (this.confirmingTask()?.id !== this.store.selectedTask()?.id) { this.closing.set(false); return; }
    this.closeBusy.set(true); this.closeError.set(null);
    if (intent.push && !await this.git.perform({ type: 'push' })) { this.closeError.set(this.git.error()); this.closeBusy.set(false); return; }
    await this.store.closeTask(true);
    this.closeBusy.set(false);
    if (this.store.error()) this.closeError.set(this.store.error()); else this.closing.set(false);
  }
  protected async copy(branch: string): Promise<void> {
    const epoch = this.epoch;
    try {
      await navigator.clipboard.writeText(branch);
      if (epoch !== this.epoch) return;
      this.copied.set(true); clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.copied.set(false), 1800);
    } catch { if (epoch === this.epoch) this.store.error.set('The branch name could not be copied.'); }
  }
  protected gitAction(action: GitAction): void {
    if (action === 'commit' || action === 'commit-push') { if (action === 'commit-push') this.pushAfter.set(true); this.commitOpen.update(open => !open); }
    else if (action === 'push' || action === 'sync') void this.git.perform({ type: action });
  }
  protected async commit(intent: CommitIntent): Promise<void> {
    if (this.git.busy() || !intent.revision) return;
    this.commitOpen.set(false);
    await this.git.perform({ type: 'commit', message: intent.message, selection: intent.selection, revision: intent.revision, push: intent.push });
  }
  protected openGitDialog(): void {
    this.dialogTask = this.store.selectedTask()?.id;
    this.gitDraft.set(this.git.summary()?.branch ?? ''); this.gitDialogOpen.set(true);
  }
  protected async submitGit(): Promise<void> {
    const value = this.gitDraft().trim();
    if (!value || this.git.busy() || this.dialogTask !== this.store.selectedTask()?.id) return;
    const saved = await this.git.perform({ type: 'rename-branch', branchName: value });
    if (saved) this.gitDialogOpen.set(false);
  }
}
