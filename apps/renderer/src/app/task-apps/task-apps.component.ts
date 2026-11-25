import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { TaskAppRun } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, TooltipDirective } from '../ui';
import { ViewTabsComponent, type ViewTab } from '../views';
import { AppStreamComponent } from './app-stream.component';

interface AppTarget { readonly scopeId: string; readonly taskId: number }
interface RunLink extends AppTarget { readonly runId: string }
interface RunSnapshot extends AppTarget { readonly runs: readonly TaskAppRun[] }
const recentTaskLimit = 4;
const labels: Record<TaskAppRun['status'], string> = {
  requested: 'Awaiting launch', starting: 'Starting', running: 'Running', stopping: 'Stopping', exited: 'Exited', failed: 'Failed',
};
/** Steady dot while running, spinner while changing state; finished runs stay quiet. */
const tabStatus: Record<TaskAppRun['status'], ViewTab['status']> = {
  requested: 'idle', starting: 'running', running: 'serving', stopping: 'running', exited: 'idle', failed: 'failed',
};
function isActive(run: TaskAppRun): boolean {
  return run.status !== 'exited' && run.status !== 'failed';
}

@Component({
  selector: 'ex-task-apps',
  imports: [AppStreamComponent, ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, TooltipDirective, ViewTabsComponent],
  templateUrl: './task-apps.component.html', styleUrl: './task-apps.component.css', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskAppsComponent {
  readonly scopeId = input<string | null>(null);
  readonly taskId = input<number | null>(null);
  readonly machine = input('');
  readonly available = input(true);
  readonly monitor = input(true);
  readonly viewerVisible = input(true);
  readonly link = input<RunLink | null>(null);
  readonly standalone = input(false);
  readonly idle = output<void>();
  readonly labels = labels;
  private readonly snapshot = signal<RunSnapshot | null>(null);
  private readonly currentSnapshot = computed(() => {
    const snapshot = this.snapshot();
    return snapshot && this.matches(snapshot) ? snapshot : null;
  });
  readonly runs = computed(() => this.currentSnapshot()?.runs ?? []);
  readonly hasActiveApp = computed(() => this.runs().some(isActive));
  readonly selected = signal('');
  readonly run = computed(() => this.runs().find(item => item.runId === this.selected()));
  readonly tabs = computed<readonly ViewTab[]>(() => {
    // A separate window belongs to one run, so it shows only that run's tab.
    const runs = this.standalone() ? this.runs().filter(item => item.runId === this.selected()) : this.runs();
    return runs.map(item => ({
      id: item.runId, title: item.name, tip: `${item.name} · ${labels[item.status]}`,
      icon: item.status === 'requested' ? 'hand' : 'window', status: tabStatus[item.status], statusLabel: labels[item.status],
    }));
  });
  readonly requestedCommand = computed(() => {
    const proposal = this.run()?.pendingLaunch;
    if (!proposal) return '';
    // Preserve argument boundaries and render bidirectional formatting controls visibly.
    return JSON.stringify([proposal.executable, ...proposal.args], null, 2)
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  });
  readonly loading = computed(() => this.monitor() && (!this.currentSnapshot() || (this.reading() && !this.run())));
  readonly readError = signal('');
  readonly actionError = signal('');
  readonly actual = signal(false);
  readonly detached = signal(false);
  readonly logsOpen = signal(false);
  readonly logs = signal<string | null>(null);
  readonly busy = signal(false);
  readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly document = inject(DOCUMENT);
  private readonly recentTasks = new Map<number, { readonly snapshot: RunSnapshot; readonly selected: string }>();
  private cacheScope: string | null = null;
  private target: AppTarget | null = null;
  private lastLink: RunLink | null = null;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly reading = signal(false);
  private pendingRead = false;
  private logGeneration = 0;
  private disposed = false;
  private requestedRun = '';

  constructor() {
    let wasMonitoring = false;
    effect(() => {
      const scopeId = this.scopeId(), taskId = this.taskId(), available = this.available();
      const monitor = this.monitor(), link = this.link();
      const resumed = monitor && !wasMonitoring;
      wasMonitoring = monitor;
      const target = scopeId && taskId && available ? { scopeId, taskId } : null;
      untracked(() => {
        const changed = this.target?.scopeId !== target?.scopeId || this.target?.taskId !== target?.taskId;
        if (scopeId !== this.cacheScope) {
          this.cacheScope = scopeId;
          this.recentTasks.clear();
        }
        if (changed) this.switchTask(target);
        const linkChanged = this.lastLink !== link;
        if (changed || linkChanged) {
          this.lastLink = link;
          const selected = this.selected();
          this.requestedRun = link && this.matches(link) && (linkChanged || !selected || selected === link.runId) ? link.runId : '';
          if (this.requestedRun && (linkChanged || this.requestedRun !== selected)) this.select(this.requestedRun);
        }
        if (!monitor) clearTimeout(this.timer);
        else if (resumed || changed || (linkChanged && this.requestedRun)) void this.refresh();
      });
    });
    const visibility = () => {
      clearTimeout(this.timer);
      if (!this.document.hidden) void this.refresh();
    };
    this.document.addEventListener('visibilitychange', visibility);
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true; this.generation++;
      clearTimeout(this.timer);
      this.document.removeEventListener('visibilitychange', visibility);
    });
  }

  private matches(target: AppTarget): boolean {
    return target.scopeId === this.scopeId() && target.taskId === this.taskId() && this.available();
  }

  private switchTask(target: AppTarget | null): void {
    this.generation++;
    clearTimeout(this.timer);
    this.reading.set(false);
    this.pendingRead = false;
    const previous = this.snapshot();
    if (previous && previous.scopeId === this.cacheScope && previous.runs.some(isActive)) {
      this.recentTasks.set(previous.taskId, { snapshot: previous, selected: this.selected() });
      if (this.recentTasks.size > recentTaskLimit) this.recentTasks.delete(this.recentTasks.keys().next().value!);
    }
    const cached = target && this.recentTasks.get(target.taskId);
    if (target) this.recentTasks.delete(target.taskId);
    this.target = target;
    this.snapshot.set(cached?.snapshot ?? null);
    this.select(cached?.selected ?? '');
    this.readError.set('');
  }

  async refresh(): Promise<void> {
    const target = this.target;
    if (this.disposed || !target || !this.matches(target) || !this.monitor() || this.document.hidden) return;
    if (!this.bridge.taskAppsRead) { this.readError.set('Update Elevenex to view apps on this machine.'); return; }
    if (this.reading()) { this.pendingRead = true; return; }
    const generation = this.generation;
    const current = () => generation === this.generation && this.matches(target);
    const link = this.link();
    this.reading.set(true);
    clearTimeout(this.timer);
    try {
      const reply = await this.bridge.taskAppsRead(target.scopeId, target.taskId);
      if (!current()) return;
      if (!reply.ok) { this.readError.set(reply.error.message); return; }
      this.readError.set('');
      this.snapshot.set({ ...target, runs: reply.value });
      if (!this.requestedRun && !reply.value.some(run => run.runId === this.selected())) {
        const run = reply.value.find(run => run.status === 'running' || run.status === 'starting') ??
          reply.value.find(isActive) ?? reply.value[0];
        this.select(run?.runId ?? '');
      }
      // An older read must not dismiss a launch link that asked for a fresh read.
      if (this.monitor() && !this.hasActiveApp() && !this.pendingRead && this.link() === link) this.idle.emit();
      if (this.viewerVisible() && this.logsOpen() && this.run()) await this.readLogs();
    } catch { if (current()) this.readError.set('Could not read apps on this machine.'); }
    finally {
      if (current()) {
        this.reading.set(false);
        if (this.pendingRead) { this.pendingRead = false; void this.refresh(); }
        else if (this.monitor() && !this.document.hidden && !this.readError()) this.timer = setTimeout(() => void this.refresh(), 2500);
      }
    }
  }

  select(id: string): void {
    this.logGeneration++;
    this.selected.set(id);
    this.busy.set(false); this.actionError.set(''); this.detached.set(false); this.actual.set(false);
    this.logsOpen.set(false); this.logs.set(null);
  }

  choose(id: string): void { this.requestedRun = ''; this.select(id); }

  toggleLogs(): void {
    this.logsOpen.update(open => !open);
    if (this.logsOpen()) void this.readLogs();
    else this.logGeneration++;
  }

  private async readLogs(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run();
    if (!scope || !task || !run) return;
    const generation = ++this.logGeneration;
    try {
      const result = await this.bridge.taskAppOutput?.(scope, task, run.runId);
      if (!this.disposed && generation === this.logGeneration)
        this.logs.set(result?.ok ? result.value : result?.error.message ?? 'App logs are unavailable.');
    } catch { if (!this.disposed && generation === this.logGeneration) this.logs.set('App logs could not be read.'); }
  }

  async act(action: 'approve' | 'stop'): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run(), generation = this.generation;
    if (!scope || !task || !run || this.busy()) return;
    this.busy.set(true); this.actionError.set('');
    const current = () => generation === this.generation && this.run()?.runId === run.runId;
    try {
      const result = action === 'approve'
        ? run.status === 'requested' && run.pendingLaunch ? await this.bridge.taskAppApprove?.(scope, task, run.runId) : undefined
        : await this.bridge.taskAppStop?.(scope, task, run.runId);
      if (current() && !result?.ok) this.actionError.set(result?.error.message ?? 'App action unavailable.');
    } catch { if (current()) this.actionError.set('The request was interrupted. Check the run before trying again.'); }
    finally { if (current()) { this.busy.set(false); void this.refresh(); } }
  }

  async popOut(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run(), generation = this.generation;
    if (!scope || !task || !run || this.busy() || !this.bridge.taskAppPopOut) return;
    this.busy.set(true); this.actionError.set('');
    const current = () => generation === this.generation && this.run()?.runId === run.runId;
    try {
      await this.bridge.taskAppPopOut(scope, task, run.runId);
      if (current()) this.detached.set(true);
    } catch { if (current()) this.actionError.set('The app window could not open.'); }
    finally { if (current()) this.busy.set(false); }
  }
}
