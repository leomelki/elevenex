import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { WorkspaceCommitPreview, WorkspaceCommitQuery, WorkspaceGitAction, WorkspaceGitSummary } from '@elevenex/shared';
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
  private previewGeneration = 0;
  private previewRevision?: string;
  private previewCheckedAt = 0;
  private previewRequest?: Promise<WorkspaceCommitPreview>;

  constructor() {
    effect(() => { const key = this.key(); untracked(() => { this.selectionEpoch++; this.revision++; clearTimeout(this.pollTimer); clearTimeout(this.phaseTimer); this.phase.set(null); this.summary.set(null); this.clearCommitPreview(); this.loading.set(false); this.busy.set(null); this.error.set(null); this.uncertain.set(false); if (key) void this.refresh(); }); });
    const refreshVisible = () => { if (!this.document.hidden) void this.refresh(); };
    this.document.addEventListener('visibilitychange', refreshVisible);
    this.document.defaultView?.addEventListener('focus', refreshVisible);
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.revision++; this.clearCommitPreview(); clearTimeout(this.pollTimer); clearTimeout(this.phaseTimer); this.document.removeEventListener('visibilitychange', refreshVisible); this.document.defaultView?.removeEventListener('focus', refreshVisible); });
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
      if (result.ok) { this.acceptSummary(result.value); this.uncertain.set(false); void this.preloadCommitPreview(selected.scopeId, selected.taskId); }
      else this.error.set(result.error.message);
    } catch { if (this.current(selected.scopeId, selected.taskId)) this.error.set('Git status could not be loaded.'); }
    finally { if (revision === this.revision) { this.loading.set(false); this.schedule(); } }
  }

  async perform(input: GitCommand): Promise<boolean> {
    const selected = this.store.selected();
    if (!selected || this.busy() || this.uncertain() || !this.current(selected.scopeId, selected.taskId)) return false;
    const epoch = this.selectionEpoch;
    this.revision++; this.loading.set(false);
    this.clearCommitPreview();
    clearTimeout(this.pollTimer);
    this.busy.set(input.type); this.error.set(null);
    if (input.type === 'commit') { this.phase.set(input.message ? 'committing' : 'writing'); this.watchPhase(selected.scopeId, selected.taskId, epoch); }
    try {
      const result = await this.bridge.workspaceGitAction(selected.scopeId, { ...input, taskId: selected.taskId });
      if (!this.current(selected.scopeId, selected.taskId) || epoch !== this.selectionEpoch) return false;
      if (result.ok) { this.acceptSummary(result.value); this.store.reconcileTaskBranch(selected.scopeId, selected.taskId, result.value.branch); void this.preloadCommitPreview(selected.scopeId, selected.taskId); return true; }
      this.error.set(result.error.message);
      if (result.error.code === 'outcome-unknown' || result.error.code === 'transport' || result.error.code === 'timeout') this.uncertain.set(true);
    } catch { if (this.current(selected.scopeId, selected.taskId) && epoch === this.selectionEpoch) { this.uncertain.set(true); this.error.set('The git operation could not be confirmed. Refresh its status before trying again.'); } }
    finally { if (this.current(selected.scopeId, selected.taskId) && epoch === this.selectionEpoch) { clearTimeout(this.phaseTimer); this.phase.set(null); this.busy.set(null); this.schedule(); } }
    return false;
  }

  /** The default page has one task-owned cache and pending read; searches/pages bypass it. */
  async readCommitPreview(scope: string, input: WorkspaceCommitQuery): Promise<WorkspaceCommitPreview> {
    if (!this.current(scope, input.taskId)) throw new Error('The selected task changed.');
    const defaults = input.includeUnstaged && !input.query && !input.cursor && !input.excluded.length && !input.includedSecrets.length;
    const revision = this.summary()?.changesRevision;
    const cached = this.commitPreview();
    if (defaults && cached && this.previewRevision === revision && Date.now() - this.previewCheckedAt < 5000) return cached;
    if (defaults && this.previewRequest) return this.previewRequest;
    const generation = this.previewGeneration;
    const read = async () => {
      const result = await this.bridge.workspaceCommitPreview(scope, input);
      if (!this.current(scope, input.taskId) || generation !== this.previewGeneration) throw new Error('The task changes moved on. Refresh the files.');
      if (!result.ok) throw new Error(result.error.message);
      if (defaults) {
        this.commitPreview.set(result.value); this.previewRevision = revision; this.previewCheckedAt = Date.now();
      }
      return result.value;
    };
    const pending = read();
    if (!defaults) return pending;
    this.previewRequest = pending;
    try { return await pending; }
    finally { if (this.previewRequest === pending) this.previewRequest = undefined; }
  }

  private acceptSummary(summary: WorkspaceGitSummary): void {
    if (summary.changesRevision !== this.summary()?.changesRevision) {
      this.previewGeneration++; this.previewRequest = undefined;
    }
    this.summary.set(summary);
  }

  private clearCommitPreview(): void {
    this.previewGeneration++; this.previewRequest = undefined; this.previewRevision = undefined;
    this.previewCheckedAt = 0; this.commitPreview.set(null);
  }

  private async preloadCommitPreview(scope: string, taskId: number): Promise<void> {
    if (!this.summary()?.files || !this.store.commitPanelAvailable()) { this.clearCommitPreview(); return; }
    if (this.document.hidden) return;
    const revision = this.summary()?.changesRevision;
    // Old engines omit the token and retain bounded polling. New engines skip unchanged pages.
    if (revision && this.commitPreview() && this.previewRevision === revision) return;
    try {
      await this.readCommitPreview(scope, { taskId, query: '', includeUnstaged: true, excluded: [], includedSecrets: [] });
    } catch {
      // Keep the previous page for display; expired/invalidated data never bypasses a fresh check.
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
