import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommitPanelComponent, CloseTaskComponent, TaskHeaderComponent, type CommitIntent, type CommitFileProvider, type CloseTaskIntent, type GitAction, type TaskStage } from '../tasks';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, IconComponent, ModalLayerComponent, SetFieldComponent, StatusGlyphComponent, TooltipDirective } from '../ui';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskGitService } from './workspace-task-git.service';
import type { WorkspaceTask } from '@elevenex/shared';

@Component({
  selector: 'ex-workspace-task-header',
  imports: [CommitPanelComponent, TaskHeaderComponent, CloseTaskComponent, ButtonComponent, IconComponent, ModalLayerComponent, SetFieldComponent, StatusGlyphComponent, TooltipDirective],
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
  readonly closeRecovery = input<WorkspaceTask>();
  protected readonly copied = signal(false);
  protected readonly closing = signal(false);
  protected readonly closeLoading = signal(false);
  protected readonly closeBusy = signal(false);
  protected readonly closeError = signal<string | null>(null);
  protected readonly commitOpen = signal(false);
  protected readonly pushAfter = signal(false);
  protected readonly controlsDisabled = computed(() =>
    !!this.store.selectedCreation() || this.store.busy() || !!this.git.busy() || this.closeLoading());
  protected readonly pull = computed(() => {
    const task = this.store.selectedTask();
    const summary = this.git.summary();
    if (task?.state !== 'ready' || task.archivedAt || !summary?.upstream || !summary.behind) return null;

    const { upstream, branch, behind, ahead, conflicted } = summary;
    const pulling = this.git.busy() === 'sync';
    const count = `${behind} ${behind === 1 ? 'commit' : 'commits'}`;
    const offline = this.store.offline();
    const diverged = ahead > 0;
    const label = pulling ? 'Pulling…' : offline ? 'Offline' : conflicted ? 'Conflicts' : diverged ? 'Diverged' : 'Pull';
    let detail = `Pull ${count} (fast-forward only).`;
    if (pulling) detail = 'Pulling from upstream…';
    else if (offline) detail = `Pull needs ${this.store.machine()?.name ?? 'the machine'} to be online.`;
    else if (conflicted) detail = 'Resolve the worktree conflicts before pulling.';
    else if (diverged) detail = `Branch has diverged: ${count} behind and ${ahead} ahead. Reconcile the branches before pulling.`;
    else if (this.git.uncertain()) detail = 'Refresh Git status before pulling.';
    else if (this.commitOpen()) detail = 'Close the commit panel before pulling.';
    else if (this.git.loading()) detail = 'Checking Git status…';
    else if (this.controlsDisabled()) detail = 'Wait for the current task operation to finish before pulling.';
    return {
      pulling, label, behind, upstream, branch, detail,
      accessibleLabel: label === 'Pull' ? `Pull ${count}` : label,
      warning: !pulling && !offline && (conflicted || diverged),
      disabled: this.controlsDisabled() || this.commitOpen() || this.git.loading() ||
        this.git.uncertain() || offline || conflicted || diverged,
    };
  });
  protected readonly gitQuietLabel = computed(() => {
    if (this.pull() || this.git.pullError()) return '';
    return this.git.summary()?.upstream ? 'Up to date' : 'No upstream';
  });
  private readonly commitTask = computed(() => {
    const selected = this.store.taskSelection();
    return selected && this.store.selectedTask()?.state === 'ready' ? { scopeId: selected.scopeId, taskId: selected.taskId } : null;
  }, { equal: (a, b) => a?.scopeId === b?.scopeId && a?.taskId === b?.taskId });
  protected readonly commitProvider = computed<CommitFileProvider | undefined>(() => {
    const selected = this.commitTask();
    if (!selected) return undefined;
    const scopeId = selected.scopeId, taskId = selected.taskId, available = this.store.commitPanelAvailable();
    return async (query, signal) => {
      if (!available) throw new Error('Update this machine’s engine to use the commit panel.');
      if (signal.aborted) throw new Error('The file check was cancelled.');
      const result = await this.git.readCommitPreview(scopeId, { taskId, ...query });
      if (signal.aborted || this.store.taskSelection()?.scopeId !== scopeId || this.store.taskSelection()?.taskId !== taskId) throw new Error('The selected task changed.');
      return result;
    };
  });
  protected readonly gitDialogOpen = signal(false);
  protected readonly gitDraft = signal('');
  private dialogTask?: number;
  protected readonly confirmingTask = signal<{ readonly key: string; readonly title: string; readonly sessions: number; readonly running: number; readonly unpushed: number; readonly uncommitted?: number; readonly terminals: number; readonly actions: number; readonly apps?: number } | null>(null);
  protected readonly project = computed(() => this.store.projects().find(project => project.id === String(this.store.selectedTask()?.projectId)));
  protected readonly repo = computed(() => {
    const task = this.store.selectedTask();
    return task?.projectRepositoryCount === 1 ? undefined : task?.repoName;
  });
  private resetTimer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private readonly closeTarget = computed(() => {
    const recovery = this.closeRecovery();
    return recovery ? { scopeId: this.store.scopeId(), task: recovery }
      : { scopeId: this.store.taskSelection()?.scopeId, task: this.store.selectedTask() };
  });
  private readonly taskKey = computed(() => {
    const { scopeId, task } = this.closeTarget();
    return scopeId && task ? `${scopeId}/${task.id}/${task.state}` : '';
  });
  constructor() {
    effect(() => {
      this.taskKey(); this.epoch++;
      this.copied.set(false); this.gitDialogOpen.set(false); this.commitOpen.set(false); this.closing.set(false); this.closeLoading.set(false); clearTimeout(this.resetTimer);
    });
    inject(DestroyRef).onDestroy(() => { this.epoch++; clearTimeout(this.resetTimer); });
  }

  protected stage(stage: TaskStage): void { if (stage === 'closed') this.close(); else void this.store.setStage(stage); }
  async close(): Promise<void> {
    if (this.store.offline()) { this.store.error.set(`Close task needs ${this.store.machine()?.name ?? 'the machine'}. Nothing was sent. Try again once it’s back.`); return; }
    const { task, scopeId } = this.closeTarget(), key = this.taskKey(), epoch = this.epoch;
    if (!task || !scopeId || this.store.busy() || this.store.mutationUncertain() || this.closeLoading()) return;
    this.closeLoading.set(true); this.closeError.set(null);
    try {
      const preview = await this.bridge.workspaceClosePreview(scopeId, task.id);
      if (epoch !== this.epoch || this.taskKey() !== key) return;
      if (preview.ok) {
        const value = preview.value;
        if (!value.running && !value.terminals && !value.actions && !value.apps && !value.unpushed && value.uncommitted === 0) await this.store.closeTask();
        else { this.confirmingTask.set({ key, title: task.name, ...value }); this.closing.set(true); }
      }
      else this.store.error.set(preview.error.message);
    } catch { if (epoch === this.epoch) this.store.error.set('The task could not be checked before closing.'); }
    finally { if (epoch === this.epoch) this.closeLoading.set(false); }
  }
  protected async confirmClose(intent: CloseTaskIntent): Promise<void> {
    const task = this.confirmingTask(), key = this.taskKey();
    if (!this.closing() || !task || task.key !== key) return;
    this.closeBusy.set(true); this.closeError.set(null);
    try {
      if (intent.push && !await this.git.perform({ type: 'push' })) { this.closeError.set(this.git.error()); return; }
      if (this.taskKey() !== key) return;
      await this.store.closeTask(true, task.apps);
      if (this.taskKey() !== key) return;
      if (this.store.error()) this.closeError.set(this.store.error()); else this.closing.set(false);
    } finally { this.closeBusy.set(false); }
  }
  protected async copy(branch: string): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.bridge.writeClipboardText(branch);
      if (epoch !== this.epoch) return;
      if (this.store.error() === 'The branch name could not be copied.') this.store.error.set(null);
      this.copied.set(true); clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.copied.set(false), 1800);
    } catch { if (epoch === this.epoch) this.store.error.set('The branch name could not be copied.'); }
  }
  protected gitAction(action: GitAction): void {
    if (this.store.selectedTask()?.state !== 'ready') return;
    if (this.git.busy() === 'sync' || this.git.uncertain()) return;
    if (this.store.offline()) { this.git.error.set(`This git action needs ${this.store.machine()?.name ?? 'the machine'}. Nothing was sent.`); return; }
    if (action === 'commit' || action === 'commit-push') { if (action === 'commit-push') this.pushAfter.set(true); this.commitOpen.update(open => !open); }
    else if (action === 'push') void this.git.perform({ type: action });
  }
  protected pullBranch(): void {
    const pull = this.pull();
    if (pull && !pull.disabled && !this.git.pullError() && !this.git.error()) void this.git.perform({ type: 'sync' });
  }
  protected refreshPullStatus(): void {
    if (!this.store.offline() && !this.git.loading() && !this.git.busy()) void this.git.refresh();
  }
  protected async commit(intent: CommitIntent): Promise<void> {
    if (this.git.busy() || !intent.revision) return;
    const epoch = this.epoch;
    const saved = await this.git.perform({ type: 'commit', message: intent.message, selection: intent.selection, revision: intent.revision, push: intent.push });
    if (saved && epoch === this.epoch) this.commitOpen.set(false);
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
