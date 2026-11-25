import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { ElevenexBridge, TaskAppClosed, TaskAppFrame, TaskAppInput, TaskAppRun, TaskAppSetupIssue } from '@elevenex/shared';
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
  async taskAppsRead() { return { ok: true as const, value: this.runs }; }
  async taskAppOutput() { return { ok: true as const, value: 'Renderer ready.\nListening for changes.' }; }
  propose(): void {
    this.runs = [{ ...run, status: 'requested', pendingLaunch: { executable: 'pnpm', args: ['run', 'desktop:dev'] } }];
  }
  requireSetup(issue: TaskAppSetupIssue): void {
    this.propose();
    this.runs = [{ ...this.runs[0]!, setupIssue: issue,
      ...(issue === 'linux-display-tools' ? { detail: 'Missing on the task machine: Xvfb, dbus-daemon.' } : {}) }];
  }
  async taskAppOpenSetupSettings() { return { ok: true as const, value: undefined }; }
  async writeClipboardText() { /* The isolated preview does not write to the host clipboard. */ }
  async taskAppApprove() { this.runs = [{ ...run, status: 'starting' }]; return { ok: true as const, value: undefined }; }
  async taskAppStop() { this.runs = [{ ...run, status: 'exited' }]; return { ok: true as const, value: undefined }; }
  async taskAppWatch(_scope: string, _task: number, _run: string, id: string) { this.watchId = id; this.receipts = 0; return { ok: true as const, value: undefined }; }
  async taskAppUnwatch(_scope: string, id: string) { if (this.watchId === id) this.watchId = ''; }
  async taskAppFrameAck(_scope: string, _id: string, sequence: number) { this.receipts = sequence; }
  async taskAppReleaseInput() { this.releases++; }
  async taskAppInput(_scope: string, _id: string, event: TaskAppInput) { this.input.push(event); }
  onTaskAppFrame(listener: (frame: TaskAppFrame) => void) { this.frame = listener; return () => { this.frame = undefined; }; }
  onTaskAppClosed(listener: (event: TaskAppClosed) => void) { this.closed = listener; return () => { this.closed = undefined; }; }
  interrupt() { if (this.watchId) this.closed?.({ scopeId: 'preview', watchId: this.watchId, reason: 'Display disconnected.' }); }
  deliver(data: Uint8Array, sequence: number, watchId = this.watchId) {
    this.frame?.({ scopeId: 'preview', taskId: run.taskId, runId: run.runId, watchId, sequence, width: 640, height: 400,
      key: true, timestamp: sequence * 33000, codec: 'avc1.42E02A', data });
  }
}
@Component({
  selector: 'ex-task-apps-demo', imports: [TaskAppsComponent], providers: [AppsFixture, { provide: ELEVENEX_BRIDGE, useExisting: AppsFixture }],
  template: '<ex-task-apps scopeId="preview" [taskId]="41" machine="Development server" [remote]="true" />',
  styles: ':host { display: flex; max-width: 800px; height: 100%; margin: auto; border-inline: 1px solid var(--line); background: var(--surface); }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskAppsDemoComponent { readonly fixture = inject(AppsFixture); }
