import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import type { TaskAppRun } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, TooltipDirective } from '../ui';
import { ViewTabsComponent, type ViewTab } from '../views';
import { AppStreamComponent } from './app-stream.component';
import { TaskAppSetupComponent } from './task-app-setup.component';
import {
  actionProblem as describeAction, clientOutdated, hostName, logsProblem as describeLogs, macName, readProblem as describeRead,
  type ActionKind, type AppPlace, type AppProblem,
} from './app-recovery';

interface AppTarget { readonly scopeId: string; readonly taskId: number }
interface RunLink extends AppTarget { readonly runId: string }
interface RunSnapshot extends AppTarget { readonly runs: readonly TaskAppRun[] }
/** A failed action stays visible only while the run is still in the state it failed in. */
interface ActionFailure { readonly problem: AppProblem; readonly status: TaskAppRun['status'] }
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
/** Invisible characters that could disguise an argument; shown as escapes instead. */
const hiddenCharacters = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** Arguments made only of these characters read unambiguously without quotes. */
const plainArgument = /^[\w./:=@%+,-]+$/;
/**
 * One readable command line that still preserves argument boundaries: any argument that is
 * empty or contains spaces, quotes or other characters is JSON-quoted, which also escapes controls.
 */
function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args]
    .map(part => plainArgument.test(part) ? part : JSON.stringify(part))
    .join(' ')
    .replace(hiddenCharacters, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

@Component({
  selector: 'ex-task-apps',
  imports: [AppStreamComponent, TaskAppSetupComponent, ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, NgTemplateOutlet, TooltipDirective, ViewTabsComponent],
  templateUrl: './task-apps.component.html', styleUrl: './task-apps.component.css', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskAppsComponent {
  readonly scopeId = input<string | null>(null);
  readonly taskId = input<number | null>(null);
  readonly machine = input('');
  readonly remote = input(false);
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
  private readonly dismissedSetup = signal('');
  readonly hasActiveApp = computed(() => this.runs().some(isActive) ||
    (!!this.run()?.setupIssue && this.run()?.runId !== this.dismissedSetup()));
  readonly selected = signal('');
  readonly run = computed(() => this.runs().find(item => item.runId === this.selected()));
  readonly tabs = computed<readonly ViewTab[]>(() => {
    // A separate window belongs to one run, so it shows only that run's tab.
    const runs = this.standalone() ? this.runs().filter(item => item.runId === this.selected()) : this.runs();
    return runs.map(item => ({
      id: item.runId, title: item.name, tip: `${item.name} · ${this.statusLabel(item)}`,
      icon: item.status === 'requested' ? 'hand' : 'window', status: tabStatus[item.status], statusLabel: this.statusLabel(item),
    }));
  });
  readonly requestedCommand = computed(() => {
    const proposal = this.run()?.pendingLaunch;
    return proposal ? formatCommand(proposal.executable, proposal.args) : '';
  });
  readonly loading = computed(() => this.monitor() && (!this.currentSnapshot() || (this.reading() && !this.run())));
  readonly place = computed<AppPlace>(() => ({ machine: this.machine(), remote: this.remote() }));
  readonly host = computed(() => hostName(this.place()));
  readonly readFailure = signal<AppProblem | null>(null);
  private readonly actionFailure = signal<ActionFailure | null>(null);
  /** The status refresh after an action can make its failure obsolete, for example a stop that did finish. */
  readonly actionProblem = computed(() => {
    const failure = this.actionFailure();
    return failure && this.run()?.status === failure.status ? failure.problem : null;
  });
  readonly logsFailure = signal<AppProblem | null>(null);
  readonly setupFeedback = signal('');
  readonly setupHelperPath = signal('');
  readonly actual = signal(false);
  readonly detached = signal(false);
  readonly logsOpen = signal(false);
  readonly logs = signal<string | null>(null);
  readonly busy = signal(false);
  readonly checkingLaunch = signal(false);
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
  private checkedLaunch: RunLink | null = null;

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
    this.dismissedSetup.set('');
    this.snapshot.set(cached?.snapshot ?? null);
    this.select(cached?.selected ?? '');
    this.readFailure.set(null);
    this.actionFailure.set(null);
  }

  async refresh(): Promise<void> {
    const target = this.target;
    if (this.disposed || !target || !this.matches(target) || !this.monitor() || this.document.hidden) return;
    if (!this.bridge.taskAppsRead) { this.readFailure.set(clientOutdated()); return; }
    if (this.reading()) { this.pendingRead = true; return; }
    const generation = this.generation;
    const current = () => generation === this.generation && this.matches(target);
    const link = this.link();
    const checkedLaunch = this.checkedLaunch;
    this.reading.set(true);
    clearTimeout(this.timer);
    try {
      const reply = await this.bridge.taskAppsRead(target.scopeId, target.taskId);
      if (!current()) return;
      if (!reply.ok) { this.readFailure.set(describeRead(reply.error, this.place())); return; }
      this.readFailure.set(null);
      const previousIssue = this.run()?.setupIssue;
      this.snapshot.set({ ...target, runs: reply.value });
      if (previousIssue !== this.run()?.setupIssue) {
        this.setupFeedback.set('');
        this.setupHelperPath.set('');
      }
      if (!this.requestedRun && !reply.value.some(run => run.runId === this.selected())) {
        const run = reply.value.find(run => run.status === 'running' || run.status === 'starting') ??
          reply.value.find(isActive) ?? reply.value[0];
        this.select(run?.runId ?? '');
      }
      // Only a read started after the launch reply can say whether the launch happened.
      if (checkedLaunch && this.checkedLaunch === checkedLaunch) {
        this.checkedLaunch = null;
        this.checkingLaunch.set(false);
        if (this.run()?.runId === checkedLaunch.runId && this.run()?.status === 'requested') this.setupFeedback.set(
          this.run()?.setupIssue ? 'Still blocked. Finish the steps above, then launch again.' : 'Not launched yet. Try again.',
        );
      }
      // An older read must not dismiss a launch link that asked for a fresh read.
      if (this.monitor() && !this.hasActiveApp() && !this.pendingRead && this.link() === link) this.idle.emit();
      if (this.viewerVisible() && this.logsOpen() && this.run()) await this.readLogs();
    } catch { if (current()) this.readFailure.set(describeRead('interrupted', this.place())); }
    finally {
      if (current()) {
        this.reading.set(false);
        if (this.pendingRead) { this.pendingRead = false; void this.refresh(); }
        else if (this.monitor() && !this.document.hidden && !this.readFailure()) this.timer = setTimeout(() => void this.refresh(), 2500);
      }
    }
  }

  select(id: string): void {
    this.logGeneration++;
    this.selected.set(id);
    this.checkedLaunch = null;
    this.checkingLaunch.set(false);
    this.busy.set(false); this.actionFailure.set(null); this.detached.set(false); this.actual.set(false);
    this.setupFeedback.set('');
    this.setupHelperPath.set('');
    this.logsOpen.set(false); this.logs.set(null); this.logsFailure.set(null);
  }

  choose(id: string): void { this.requestedRun = ''; this.dismissedSetup.set(''); this.select(id); }

  statusLabel(run: TaskAppRun): string {
    return run.setupIssue && (run.status === 'requested' || run.status === 'failed') ? 'Setup required' : labels[run.status];
  }

  dismissSetup(): void {
    this.dismissedSetup.set(this.selected());
    const active = this.runs().find(isActive);
    if (active) this.choose(active.runId);
    else this.idle.emit();
  }

  toggleLogs(): void {
    this.logsOpen.update(open => !open);
    if (this.logsOpen()) void this.readLogs();
    else this.logGeneration++;
  }

  private async readLogs(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run();
    if (!scope || !task || !run) return;
    const generation = ++this.logGeneration;
    const place = this.place();
    const settle = (output: string | null, failure: AppProblem | null) => {
      if (this.disposed || generation !== this.logGeneration) return;
      if (output !== null) this.logs.set(output);
      this.logsFailure.set(failure);
    };
    try {
      if (!this.bridge.taskAppOutput) { settle(null, describeLogs('unsupported', place)); return; }
      const result = await this.bridge.taskAppOutput(scope, task, run.runId);
      if (result.ok) settle(result.value, null); else settle(null, describeLogs(result.error, place));
    } catch { settle(null, describeLogs('interrupted', place)); }
  }

  retryLogs(): void { if (this.logsOpen()) void this.readLogs(); }

  dismissAction(): void { this.actionFailure.set(null); }

  async act(action: 'approve' | 'stop' | 'setup-settings'): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run(), generation = this.generation;
    if (!scope || !task || !run || this.busy()) return;
    this.busy.set(true); this.actionFailure.set(null); this.setupFeedback.set('');
    this.checkingLaunch.set(action === 'approve');
    const current = () => generation === this.generation && this.run()?.runId === run.runId;
    const place = this.place();
    const kind: ActionKind = action === 'approve' ? 'launch' : action === 'setup-settings' ? 'open-setup' : run.status === 'requested' ? 'decline' : 'stop';
    const surface = run.setupIssue?.startsWith('macos-') ? 'Elevenex Agent setup' : 'System Settings';
    const fail = (failure: Parameters<typeof describeAction>[1]) =>
      this.actionFailure.set({ problem: describeAction(kind, failure, { name: run.name, place, surface }), status: run.status });
    try {
      const invoke = action === 'approve' ? this.bridge.taskAppApprove
        : action === 'stop' ? this.bridge.taskAppStop : this.bridge.taskAppOpenSetupSettings;
      if (action === 'approve' && (run.status !== 'requested' || !run.pendingLaunch)) return;
      if (!invoke) { fail('unsupported'); return; }
      const result = await invoke.call(this.bridge, scope, task, run.runId);
      if (!current()) return;
      if (!result.ok) fail(result.error);
      // Keep showing progress until a fresh read reconciles the launch.
      else if (action === 'approve') this.checkedLaunch = { scopeId: scope, taskId: task, runId: run.runId };
      // The host's screen is out of sight, so only say that it was asked.
      else if (action === 'setup-settings' && this.run()?.setupIssue === run.setupIssue) {
        const target = run.setupIssue?.startsWith('macos-') ? 'the Elevenex Agent window' : 'Settings';
        this.setupFeedback.set(place.remote ? `Sent to ${hostName(place)}. Continue on its screen.` : `Look for ${target}.`);
      }
    } catch { if (current()) fail('interrupted'); }
    finally {
      if (current()) {
        if (!this.checkedLaunch) this.checkingLaunch.set(false);
        this.busy.set(false);
        void this.refresh();
      }
    }
  }

  async revealSetupHelper(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run(), generation = this.generation;
    if (!scope || !task || !run || this.busy() || !this.bridge.taskAppRevealSetupHelper) return;
    this.busy.set(true); this.actionFailure.set(null); this.setupFeedback.set('');
    const current = () => generation === this.generation && this.run()?.runId === run.runId;
    const place = this.place(), mac = macName(place);
    const fail = (failure: Parameters<typeof describeAction>[1]) =>
      this.actionFailure.set({ problem: describeAction('reveal-agent', failure, { name: run.name, place }), status: run.status });
    try {
      const result = await this.bridge.taskAppRevealSetupHelper(scope, task, run.runId);
      if (!current() || this.run()?.setupIssue !== run.setupIssue) return;
      if (result.ok) {
        this.setupHelperPath.set(result.value.path);
        this.setupFeedback.set(!result.value.revealed ? `Finder didn't open on ${mac}. Use the path instead.`
          : place.remote ? `Sent to ${mac}. Continue in Finder there.` : 'Look for the Finder window.');
      } else fail(result.error);
    } catch { if (current()) fail('interrupted'); }
    finally { if (current()) this.busy.set(false); }
  }

  async copySetup(text: string, success?: string): Promise<void> {
    const generation = this.generation, run = this.run();
    if (!run) return;
    let message: string;
    try {
      await this.bridge.writeClipboardText(text);
      message = success ?? (this.remote() ? `Steps copied. Send them to someone at ${this.host()}.` : 'Steps copied.');
    } catch { message = 'Couldn\'t copy. Select the text instead.'; }
    if (generation === this.generation && this.run()?.runId === run.runId && this.run()?.setupIssue === run.setupIssue)
      this.setupFeedback.set(message);
  }

  async popOut(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), run = this.run(), generation = this.generation;
    if (!scope || !task || !run || this.busy() || !this.bridge.taskAppPopOut) return;
    this.busy.set(true); this.actionFailure.set(null);
    const current = () => generation === this.generation && this.run()?.runId === run.runId;
    try {
      await this.bridge.taskAppPopOut(scope, task, run.runId);
      if (current()) this.detached.set(true);
    } catch {
      if (current()) this.actionFailure.set({ problem: describeAction('open-window', 'interrupted', { name: run.name, place: this.place() }), status: run.status });
    }
    finally { if (current()) this.busy.set(false); }
  }
}
