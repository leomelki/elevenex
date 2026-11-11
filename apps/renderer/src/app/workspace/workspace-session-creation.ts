import { signal } from '@angular/core';
import type { ElevenexBridge, WorkspaceSession } from '@elevenex/shared';
import { createSessionDraft, type StartingSession } from '../session-chat/session-chat-drafts';

/** Workspace-owned local drafts and create requests. Never invents durable IDs or replays writes. */
export class WorkspaceSessionCreation {
  private readonly records = signal<readonly StartingSession[]>([]);
  readonly items = this.records.asReadonly();
  private disposed = false;

  constructor(
    private readonly bridge: Pick<ElevenexBridge, 'workspaceCreateSession'>,
    private readonly valid: (scope: string) => boolean,
    private readonly created: (starting: StartingSession, session: WorkspaceSession) => void,
  ) {}

  start(scopeId: string, taskId: number): StartingSession | null {
    const existing = this.items().find(item => item.scopeId === scopeId && item.taskId === taskId);
    if (existing) return existing;
    if (this.disposed || this.items().length >= 10) return null;
    const item: StartingSession = { id: `starting-${crypto.randomUUID()}`, scopeId, taskId, draft: createSessionDraft(), status: 'creating' };
    this.records.update(items => [...items, item]);
    return item;
  }

  async send(id: string): Promise<void> {
    const item = this.items().find(item => item.id === id);
    if (!item || item.status !== 'creating' || this.requests.has(id) || !this.valid(item.scopeId)) return;
    this.requests.add(id);
    const current = () => !this.disposed && this.items().some(entry => entry.id === id && entry.scopeId === item.scopeId && entry.status === 'creating');
    try {
      const result = await this.bridge.workspaceCreateSession(item.scopeId, { taskId: item.taskId });
      if (!current()) return;
      if (!this.valid(item.scopeId)) { this.unknown(id); return; }
      if (result.ok) {
        this.created(item, result.value);
        this.records.update(items => items.filter(entry => entry.id !== id));
      } else if (['outcome-unknown', 'transport', 'timeout', 'stale-scope'].includes(result.error.code)) this.unknown(id);
      else this.update(id, { status: 'failed', error: result.error.message });
    } catch { if (current()) this.unknown(id); }
    finally { this.requests.delete(id); }
  }
  private readonly requests = new Set<string>();

  async retry(id: string): Promise<void> {
    const item = this.items().find(item => item.id === id);
    if (!item || item.status !== 'failed' || !this.valid(item.scopeId)) return;
    this.update(id, { status: 'creating', error: undefined });
    await this.send(id);
  }
  discard(id: string): void {
    this.records.update(items => items.filter(item => item.id !== id || item.status === 'creating'));
  }
  rebind(previous: string, next: string): void {
    this.records.update(items => items.map(item => item.scopeId === previous
      ? { ...item, scopeId: next, ...(item.status === 'creating' ? { status: 'unknown' as const, error: 'Session creation could not be confirmed. Check this task’s sessions before creating another.' } : {}) } : item));
  }
  reset(): void { this.records.set([]); }
  dispose(): void { this.disposed = true; this.reset(); }
  private unknown(id: string): void {
    this.update(id, { status: 'unknown', error: 'Session creation could not be confirmed. Check this task’s sessions before creating another.' });
  }
  private update(id: string, patch: Partial<StartingSession>): void {
    this.records.update(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  }
}
