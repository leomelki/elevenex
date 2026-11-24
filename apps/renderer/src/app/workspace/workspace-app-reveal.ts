import type { BackendResult, WorkspaceRevision } from '@elevenex/shared';
import type { WorkspaceSelection } from './workspace.models';

type RevisionRead = () => Promise<BackendResult<WorkspaceRevision>>;

/** Only an uninterrupted foreground observation may reveal a newly launched app.
 * Selection/focus changes use the next existing navigation read to establish a
 * fresh baseline. Background launches cannot steal the panel on return. */
export class WorkspaceAppReveal {
  private previous?: WorkspaceSelection;
  private epoch = 0;
  private floor = -1;
  readonly reset = () => { this.previous = undefined; this.epoch++; this.floor = -1; };

  private readonly focus = () => { this.reset(); this.rebaseline?.(); };

  constructor(private readonly document: Document, private readonly selected: () => WorkspaceSelection | null,
    private readonly open: (target: WorkspaceSelection & { runId: string }) => void, private readonly rebaseline?: () => void) {
    document.addEventListener('visibilitychange', this.reset);
    document.defaultView?.addEventListener('blur', this.reset);
    document.defaultView?.addEventListener('focus', this.focus);
  }

  dispose(): void {
    this.reset();
    this.document.removeEventListener('visibilitychange', this.reset);
    this.document.defaultView?.removeEventListener('blur', this.reset);
    this.document.defaultView?.removeEventListener('focus', this.focus);
  }

  async wait(scope: string, after: number, read: RevisionRead, wait: RevisionRead): Promise<BackendResult<WorkspaceRevision>> {
    const target = this.selected(), epoch = this.epoch;
    const visible = () => !this.document.hidden && this.document.hasFocus();
    const eligible = target && target.scopeId === scope && visible();
    const needsBaseline = eligible && this.previous !== target;
    const result = await (needsBaseline ? read() : wait());
    if (!result.ok || !eligible || !visible() || this.epoch !== epoch || this.selected() !== target) return result;
    const from = Math.max(after, this.floor);
    this.floor = needsBaseline ? result.value.revision : Math.max(this.floor, result.value.revision);
    this.previous = target;
    if (!needsBaseline) {
      let latest: NonNullable<WorkspaceRevision['appOpens']>[number] | undefined;
      for (const hint of result.value.appOpens ?? []) {
        if (hint.taskId === target.taskId && hint.sessionId === target.sessionId &&
            hint.revision > (latest?.revision ?? from) && hint.revision <= result.value.revision) latest = hint;
      }
      if (latest) this.open({ ...target, runId: latest.runId });
    }
    return result;
  }
}
