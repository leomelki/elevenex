import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { WorkspaceCommitPreview, WorkspaceGitAction, WorkspaceGitSummary } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import type { GitState } from '../tasks';
import { WorkspaceStore } from './workspace.store';

type GitCommand<Action = WorkspaceGitAction> = Action extends WorkspaceGitAction ? Omit<Action, 'taskId'> : never;

/** Selected-task git state has its own request lifetime, independent of sidebar pages. */
@Injectable()
export class WorkspaceTaskGitService {
  private readonly store = inject(WorkspaceStore);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly backend = inject(BackendClientService);
  private readonly document = inject(DOCUMENT);
  readonly summary = signal<WorkspaceGitSummary | null>(null);
  readonly commitPreview = signal<WorkspaceCommitPreview | null>(null);
  readonly loading = signal(false);
  readonly busy = signal<WorkspaceGitAction['type'] | null>(null);
  readonly error = signal<string | null>(null);
  readonly uncertain = signal(false);
  private readonly phase = signal<'writing' | 'committing' | 'pushing' | null>(null);
  private phaseTimer?: ReturnType<typeof setTimeout>;
  readonly state = computed<GitState | undefined>(() => {
    const git = this.summary();
    return git ? { files: git.files, add: git.additions, del: git.deletions, ahead: git.ahead, ...(this.busy() === 'commit' ? { busy: this.phase() === 'pushing' ? 'push' as const : 'commit' as const, busyLabel: this.phase() === 'writing' ? 'Writing the message…' : undefined } : this.busy() === 'push' ? { busy: 'push' as const } : {}) } : undefined;
  });
  private readonly key = computed(() => { const selected = this.store.selected(), task = this.store.selectedTask(); return selected && task?.state !== 'finished' && !task?.archivedAt ? `${selected.scopeId}/${selected.taskId}` : ''; });
  private revision = 0;
  private disposed = false;
  private selectionEpoch = 0;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => { const key = this.key(); untracked(() => { this.selectionEpoch++; this.revision++; clearTimeout(this.pollTimer); clearTimeout(this.phaseTimer); this.phase.set(null); this.summary.set(null); this.commitPreview.set(null); this.loading.set(false); this.busy.set(null); this.error.set(null); this.uncertain.set(false); if (key) void this.refresh(); }); });
    const refreshVisible = () => { if (!this.document.hidden) void this.refresh(); };
    this.document.addEventListener('visibilitychange', refreshVisible);
    this.document.defaultView?.addEventListener('focus', refreshVisible);
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.revision++; clearTimeout(this.pollTimer); clearTimeout(this.phaseTimer); this.document.removeEventListener('visibilitychange', refreshVisible); this.document.defaultView?.removeEventListener('focus', refreshVisible); });
  }

  async refresh(): Promise<void> {
    const selected = this.store.selected();
    if (!selected || !this.key() || this.loading() || this.busy() || !this.current(selected.scopeId, selected.taskId)) return;
    clearTimeout(this.pollTimer);
    const revision = ++this.revision;
    this.loading.set(true); this.error.set(null);
    try {
      const result = await this.bridge.workspaceGit(selected.scopeId, selected.taskId);
      if (!this.current(selected.scopeId, selected.taskId) || revision !== this.revision) return;
      if (result.ok) { this.summary.set(result.value); this.uncertain.set(false); void this.preloadCommitPreview(selected.scopeId, selected.taskId, revision); }
      else this.error.set(result.error.message);
    } catch { if (this.current(selected.scopeId, selected.taskId)) this.error.set('Git status could not be loaded.'); }
    finally { if (revision === this.revision) { this.loading.set(false); this.schedule(); } }
  }

  async perform(input: GitCommand): Promise<boolean> {
    const selected = this.store.selected();
    if (!selected || this.busy() || this.uncertain() || !this.current(selected.scopeId, selected.taskId)) return false;
    const epoch = this.selectionEpoch;
    this.revision++; this.loading.set(false);
    this.commitPreview.set(null);
    clearTimeout(this.pollTimer);
    this.busy.set(input.type); this.error.set(null);
    if (input.type === 'commit') { this.phase.set(input.message ? 'committing' : 'writing'); this.watchPhase(selected.scopeId, selected.taskId, epoch); }
    try {
      const result = await this.bridge.workspaceGitAction(selected.scopeId, { ...input, taskId: selected.taskId });
      if (!this.current(selected.scopeId, selected.taskId) || epoch !== this.selectionEpoch) return false;
      if (result.ok) { this.summary.set(result.value); this.store.reconcileTaskBranch(selected.scopeId, selected.taskId, result.value.branch); void this.preloadCommitPreview(selected.scopeId, selected.taskId, this.revision); return true; }
      this.error.set(result.error.message);
      if (result.error.code === 'outcome-unknown' || result.error.code === 'transport' || result.error.code === 'timeout') this.uncertain.set(true);
    } catch { if (this.current(selected.scopeId, selected.taskId) && epoch === this.selectionEpoch) { this.uncertain.set(true); this.error.set('The git operation could not be confirmed. Refresh its status before trying again.'); } }
    finally { if (this.current(selected.scopeId, selected.taskId) && epoch === this.selectionEpoch) { clearTimeout(this.phaseTimer); this.phase.set(null); this.busy.set(null); this.schedule(); } }
    return false;
  }

  private async preloadCommitPreview(scope: string, taskId: number, revision: number): Promise<void> {
    if (!this.summary()?.files || !this.store.commitPanelAvailable()) { this.commitPreview.set(null); return; }
    if (this.document.hidden) return;
    try {
      // Keep only the default first page. Main coalesces this with an opening panel's identical read.
      const result = await this.bridge.workspaceCommitPreview(scope, { taskId, query: '', includeUnstaged: true, excluded: [], includedSecrets: [] });
      if (this.current(scope, taskId) && revision === this.revision) this.commitPreview.set(result.ok ? result.value : null);
    } catch {
      // Preloading is optional; the panel reports errors from its own fresh check.
      if (this.current(scope, taskId) && revision === this.revision) this.commitPreview.set(null);
    }
  }

  private watchPhase(scope: string, taskId: number, epoch: number): void {
    this.phaseTimer = setTimeout(() => {
      if (!this.current(scope, taskId) || epoch !== this.selectionEpoch || this.busy() !== 'commit') return;
      void this.bridge.workspaceGit(scope, taskId).then(result => {
        if (this.current(scope, taskId) && epoch === this.selectionEpoch && this.busy() === 'commit') {
          if (result.ok && result.value.commitPhase) this.phase.set(result.value.commitPhase);
          this.watchPhase(scope, taskId, epoch);
        }
      }, () => { if (this.current(scope, taskId) && epoch === this.selectionEpoch && this.busy() === 'commit') this.watchPhase(scope, taskId, epoch); });
    }, 1000);
  }
  private current(scope: string, taskId: number): boolean { return !this.disposed && !!this.key() && this.backend.state().scope?.id === scope && this.store.selected()?.scopeId === scope && this.store.selected()?.taskId === taskId; }
  private schedule(): void {
    clearTimeout(this.pollTimer);
    if (this.disposed || this.document.hidden || !this.store.selected()) return;
    this.pollTimer = setTimeout(() => { this.pollTimer = undefined; if (!this.document.hidden) void this.refresh(); }, 5000);
  }
}
