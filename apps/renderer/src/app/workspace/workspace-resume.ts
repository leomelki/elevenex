import { signal } from '@angular/core';
import type { ElevenexBridge, EnvironmentContext, EnvironmentSelection } from '@elevenex/shared';

/** Serializes layout saves; only the latest pending snapshot is retained. */
export class WorkspaceResume {
  readonly error = signal<string | null>(null);
  private pending?: { readonly context: EnvironmentContext; readonly environment: EnvironmentSelection; readonly current: () => boolean };
  private writing = false;
  private previous = '';
  private context: EnvironmentContext | null = null;

  constructor(private readonly bridge: Pick<ElevenexBridge, 'environmentStatus' | 'saveEnvironmentContext'>) {}

  async load(environment: EnvironmentSelection, current: () => boolean): Promise<EnvironmentContext | null> {
    this.context = null; this.previous = ''; this.pending = undefined; this.error.set(null);
    try {
      const snapshot = await this.bridge.environmentStatus();
      if (!current()) return null;
      if (snapshot.selection.kind !== environment.kind || (environment.kind === 'remote' && snapshot.selection.kind === 'remote' && snapshot.selection.hostId !== environment.hostId)) return null;
      this.context = snapshot.context;
      return snapshot.context;
    } catch {
      if (current()) this.error.set('The saved workspace could not be loaded. Refresh to try again.');
      return null;
    }
  }

  save(selection: Pick<EnvironmentContext, 'projectId' | 'taskId' | 'sessionId' | 'workspace'>, environment: EnvironmentSelection, current: () => boolean): void {
    // Never overwrite a saved workspace when its initial read failed.
    if (!this.context || !current()) return;
    const context = { ...this.context, ...selection }, key = JSON.stringify({ environment, context });
    if (key === this.previous) return;
    this.previous = key;
    this.pending = { context, environment, current };
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending) {
        const job = this.pending; this.pending = undefined;
        if (!job.current()) continue;
        try {
          await this.bridge.saveEnvironmentContext(job.context, job.environment);
          if (job.current()) this.error.set(null);
        } catch {
          if (job.current()) { this.previous = ''; this.error.set('The workspace could not be saved. Your next change will try again.'); }
        }
      }
    } finally { this.writing = false; }
  }

  /** Dispatch before the owner disappears; main already serializes atomic writes. */
  flushBeforeExit(): void {
    const job = this.pending; this.pending = undefined;
    if (job?.current()) void this.bridge.saveEnvironmentContext(job.context, job.environment).catch(() => undefined);
  }

  reset(): void { this.pending = undefined; this.context = null; this.previous = ''; this.error.set(null); }
}
