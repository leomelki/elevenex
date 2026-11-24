import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { TaskAppRun } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, TooltipDirective } from '../ui';
import { ViewTabsComponent, type ViewTab } from '../views';
import { AppStreamComponent } from './app-stream.component';

interface RunLink { readonly scopeId: string; readonly taskId: number; readonly runId: string }
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
  readonly viewerVisible = input(true);
  readonly link = input<RunLink | null>(null);
  readonly standalone = input(false);
  readonly idle = output<void>();
  readonly labels = labels;
  readonly runs = signal<readonly TaskAppRun[]>([]);
  private readonly readTarget = signal<{ readonly scopeId: string; readonly taskId: number } | null>(null);
  readonly hasActiveApp = computed(() => {
    const read = this.readTarget();
    return this.available() && !!read && read.scopeId === this.scopeId() && read.taskId === this.taskId() && this.runs().some(isActive);
  });
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
  readonly loading = signal(false);
  readonly readError = signal('');
  readonly actionError = signal('');
  readonly actual = signal(false);
  readonly detached = signal(false);
  readonly logsOpen = signal(false);
  readonly logs = signal<string | null>(null);
  readonly busy = signal(false);
  readonly bridge = inject(ELEVENEX_BRIDGE);
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private readOnce = false;
  private pendingRead = false;
  private logGeneration = 0;
  private disposed = false;
  private requestedRun = '';

  constructor() {
    effect(() => {
      const scope = this.scopeId(), task = this.taskId(), available = this.available();
      untracked(() => {
        this.generation++;
        this.readOnce = false;
        clearTimeout(this.timer);
        this.reading = this.pendingRead = false;
        this.readTarget.set(null);
        this.runs.set([]);
        this.select('');
        this.readError.set('');
        this.loading.set(false);
        if (scope && task && available) void this.refresh();
      });
    });
    effect(() => {
      const link = this.link(), scope = this.scopeId(), task = this.taskId();
      this.requestedRun = link && link.scopeId === scope && link.taskId === task ? link.runId : '';
      if (this.requestedRun) untracked(() => { this.select(this.requestedRun); void this.refresh(); });
    });
    const visibility = () => {
      clearTimeout(this.timer);
      if (!document.hidden) void this.refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true; this.generation++;
      clearTimeout(this.timer);
      document.removeEventListener('visibilitychange', visibility);
    });
  }

  async refresh(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId();
    if (this.disposed || !scope || !task || !this.available() || document.hidden) return;
    if (!this.bridge.taskAppsRead) { this.readError.set('Update Elevenex to view apps on this machine.'); return; }
    if (this.reading) { this.pendingRead = true; return; }
    const generation = this.generation;
    const link = this.link();
    this.reading = true;
    clearTimeout(this.timer);
    if (!this.readOnce && !this.readError()) this.loading.set(true);
    try {
      const reply = await this.bridge.taskAppsRead(scope, task);
      if (generation !== this.generation) return;
      if (!reply.ok) { this.readError.set(reply.error.message); return; }
      this.readOnce = true;
      this.readError.set('');
      this.runs.set(reply.value);
      this.readTarget.set({ scopeId: scope, taskId: task });
      if (!this.requestedRun && !reply.value.some(run => run.runId === this.selected())) {
        const run = reply.value.find(run => run.status === 'running' || run.status === 'starting') ??
          reply.value.find(isActive) ?? reply.value[0];
        this.select(run?.runId ?? '');
      }
      // An older read must not dismiss a launch link that asked for a fresh read.
      if (!this.hasActiveApp() && !this.pendingRead && this.link() === link) this.idle.emit();
      if (this.viewerVisible() && this.logsOpen() && this.run()) await this.readLogs();
    } catch { if (generation === this.generation) this.readError.set('Could not read apps on this machine.'); }
    finally {
      if (generation === this.generation) {
        this.reading = false;
        this.loading.set(false);
        if (this.pendingRead) { this.pendingRead = false; void this.refresh(); }
        else if (!document.hidden && !this.readError()) this.timer = setTimeout(() => void this.refresh(), 2500);
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
    const current = () => generation === this.generation && run.runId === this.selected();
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
    const current = () => generation === this.generation && run.runId === this.selected();
    try {
      await this.bridge.taskAppPopOut(scope, task, run.runId);
      if (current()) this.detached.set(true);
    } catch { if (current()) this.actionError.set('The app window could not open.'); }
    finally { if (current()) this.busy.set(false); }
  }
}
