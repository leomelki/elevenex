import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import { CodeAuthorization, type CodeWorkspace } from './code-authorization.service.js';
import { CodeSearch } from './code-search.service.js';
import { CodeWatch } from './code-watch.service.js';
/** Reconcile task lifecycle invalidations without rescanning any repository tree. */
@Injectable()
export class CodeLifetimes implements OnModuleDestroy {
  private readonly active = new Map<string, { workspace: CodeWorkspace; at: number }>();
  private pending = false;
  private again = false;
  private disposed = false;
  private readonly invalidated = () => {
    if (this.disposed) return;
    if (this.pending) { this.again = true; return; }
    this.pending = true;
    queueMicrotask(() => { void this.reconcile().finally(() => { this.pending = false; if (this.again) { this.again = false; this.invalidated(); } }); });
  };
  constructor(private readonly navigation: NavigationEventsService, private readonly authorization: CodeAuthorization, private readonly search: CodeSearch, private readonly watches: CodeWatch) {
    navigation.on('tree-invalidated', this.invalidated);
  }
  touch(workspace: CodeWorkspace): void {
    this.active.delete(workspace.identity);
    if (this.active.size >= 16) this.release(this.active.keys().next().value!);
    this.active.set(workspace.identity, { workspace, at: Date.now() });
  }
  onModuleDestroy(): void { this.disposed = true; this.navigation.off('tree-invalidated', this.invalidated); for (const id of this.active.keys()) this.release(id); }
  private release(identity: string): void { this.active.delete(identity); this.search.release(identity); this.watches.release(identity); }
  private async reconcile(): Promise<void> {
    for (const [identity, owner] of this.active) {
      if (this.disposed) return;
      if (Date.now() - owner.at > 120_000) { this.release(identity); continue; }
      try { await this.authorization.workspace(owner.workspace.taskId, identity); }
      catch { this.release(identity); }
    }
  }
}
