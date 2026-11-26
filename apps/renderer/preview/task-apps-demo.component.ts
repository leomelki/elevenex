import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { APP_INPUT_GUIDANCE, type BackendClientError, type BackendResult, type ElevenexBridge, type TaskAppClosed, type TaskAppFrame, type TaskAppInput, type TaskAppRun, type TaskAppSetupIssue } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { TaskAppsComponent } from '../src/app/task-apps';

const run: TaskAppRun = { taskId: 41, runId: '79899b23-e16c-435d-9a57-22b0c5b407ce', mode: 'stream', status: 'running', startedAt: 1, name: 'Elevenex Desktop' };

/** Test-only presentation transport. Captures deliver real encoded packets. */
class AppsFixture implements Partial<ElevenexBridge> {
  runs: readonly TaskAppRun[] = [run];
  private frame?: (frame: TaskAppFrame) => void;
  private closed?: (event: TaskAppClosed) => void;
  watchId = '';
  receipts = 0;
  releases = 0;
  readonly input: TaskAppInput[] = [];
  /** Failures the next matching call returns, so captures can show recovery states. */
  readFailure: BackendClientError | null = null;
  logsFailure: BackendClientError | null = null;
  watchRefusal: BackendClientError | null = null;
  actionFailure: BackendClientError | null = null;
  /** A successful host check can still leave a setup-blocked proposal waiting. */
  setupBlocked = false;
  holdApproval = false;
  private pendingApproval?: () => void;
  releaseApproval(): void { this.holdApproval = false; this.pendingApproval?.(); this.pendingApproval = undefined; }
  /** A rejected input call carries the host's guidance behind Electron's IPC prefix. */
  inputGuidance: keyof typeof APP_INPUT_GUIDANCE | null = null;
  async taskAppsRead(): Promise<BackendResult<readonly TaskAppRun[]>> {
    return this.readFailure ? { ok: false, error: this.readFailure } : { ok: true, value: this.runs };
  }
  async taskAppOutput(): Promise<BackendResult<string>> {
    return this.logsFailure ? { ok: false, error: this.logsFailure } : { ok: true, value: 'Renderer ready.\nListening for changes.' };
  }
  setRun(change: Partial<TaskAppRun> & Pick<TaskAppRun, 'status'>): void {
    this.runs = [{ ...run, ...change }];
  }
  private async mutate(next?: () => void): Promise<BackendResult<void>> {
    if (this.actionFailure) return { ok: false, error: this.actionFailure };
    next?.();
    return { ok: true, value: undefined };
  }
  propose(): void {
    this.runs = [{ ...run, status: 'requested', pendingLaunch: { executable: 'pnpm', args: ['run', 'desktop:dev'] } }];
  }
  requireSetup(issue: TaskAppSetupIssue): void {
    this.propose();
    this.runs = [{ ...this.runs[0]!, setupIssue: issue,
      ...(issue === 'linux-display-tools' ? { detail: 'Missing on the task machine: Xvfb, dbus-daemon.' } : {}) }];
  }
  async taskAppOpenSetupSettings() { return this.mutate(); }
  async taskAppRevealSetupHelper() {
    return { ok: true as const, value: { path: '/Users/demo/.elevenex/runtimes/current/backend/bin/Elevenex Agent.app', revealed: true } };
  }
  async writeClipboardText() { /* The isolated preview does not write to the host clipboard. */ }
  async taskAppApprove() {
    if (this.holdApproval) await new Promise<void>(resolve => { this.pendingApproval = resolve; });
    return this.mutate(() => { if (!this.setupBlocked) this.runs = [{ ...run, status: 'starting' }]; });
  }
  async taskAppStop() { return this.mutate(() => { this.runs = [{ ...run, status: 'exited' }]; }); }
  async taskAppWatch(_scope: string, _task: number, _run: string, id: string): Promise<BackendResult<void>> {
    if (this.watchRefusal) return { ok: false, error: this.watchRefusal };
    this.watchId = id; this.receipts = 0;
    return { ok: true, value: undefined };
  }
  async taskAppUnwatch(_scope: string, id: string) { if (this.watchId === id) this.watchId = ''; }
  async taskAppFrameAck(_scope: string, _id: string, sequence: number) { this.receipts = sequence; }
  async taskAppReleaseInput() { this.releases++; }
  async taskAppInput(_scope: string, _id: string, event: TaskAppInput) {
    if (this.inputGuidance) throw new Error("Error invoking remote method 'task-app:input': Error: " + APP_INPUT_GUIDANCE[this.inputGuidance]);
    this.input.push(event);
  }
  onTaskAppFrame(listener: (frame: TaskAppFrame) => void) { this.frame = listener; return () => { this.frame = undefined; }; }
  onTaskAppClosed(listener: (event: TaskAppClosed) => void) { this.closed = listener; return () => { this.closed = undefined; }; }
  interrupt(reason = 'Display disconnected.') { if (this.watchId) this.closed?.({ scopeId: 'preview', watchId: this.watchId, reason }); }
  deliver(data: Uint8Array, sequence: number, watchId = this.watchId) {
    this.frame?.({ scopeId: 'preview', taskId: run.taskId, runId: run.runId, watchId, sequence, width: 640, height: 400,
      key: true, timestamp: sequence * 33000, codec: 'avc1.42E02A', data });
  }
}
@Component({
  selector: 'ex-task-apps-demo', imports: [TaskAppsComponent], providers: [AppsFixture, { provide: ELEVENEX_BRIDGE, useExisting: AppsFixture }],
  template: '<ex-task-apps scopeId="preview" [taskId]="41" [machine]="machine()" [remote]="remote()" />',
  styles: ':host { display: flex; max-width: 800px; height: 100%; margin: auto; border-inline: 1px solid var(--line); background: var(--surface); }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskAppsDemoComponent {
  readonly fixture = inject(AppsFixture);
  readonly machine = signal('Development server');
  readonly remote = signal(true);
}
