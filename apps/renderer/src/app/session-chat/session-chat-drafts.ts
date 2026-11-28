import { DestroyRef, Injectable, inject } from '@angular/core';
import type { EnvironmentSelection, SessionChatDraftTarget, SessionChatItem, SessionChatState } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { SessionDraft } from './session-chat-draft';
import type { ChatSelection } from './session-chat.store';

export { SessionDraft, type AttachmentDraft } from './session-chat-draft';

/** A local conversation has no backend identity until creation is confirmed. */
export interface StartingSession {
  readonly id: string;
  readonly scopeId: string;
  readonly taskId: number;
  readonly draft: SessionDraft;
  readonly status: 'creating' | 'failed' | 'unknown';
  readonly error?: string;
}

interface ChatSnapshot {
  readonly items: readonly SessionChatItem[];
  readonly leadingPrompt: SessionChatItem | null;
  readonly state: SessionChatState;
  readonly before: string | null;
}

/** Bounded live entries and transcript snapshots for the connected workspace. */
@Injectable()
export class SessionChatDrafts {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private environment?: EnvironmentSelection;
  private scope = '';
  private readonly entries = new Map<number, SessionDraft>();
  private readonly snapshots = new Map<number, ChatSnapshot>();

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.environment = undefined; });
  }

  selectMachine(environment: EnvironmentSelection): void {
    this.environment = environment;
    this.scope = '';
    this.entries.clear();
    this.snapshots.clear();
  }

  remember({ scopeId, sessionId }: ChatSelection, snapshot: ChatSnapshot): void {
    if (scopeId !== this.scope) return;
    this.snapshots.delete(sessionId);
    // Five 1 MiB transcript snapshots, with the existing 320-item window cap.
    if (JSON.stringify(snapshot).length > 1_000_000) return;
    this.snapshots.set(sessionId, snapshot);
    if (this.snapshots.size > 5) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  snapshot(session: number) { return this.snapshots.get(session); }
  /** Same machine only, after workspace recovery; opaque scope IDs themselves are never persisted. */
  rebind(previous: string, next: string): void { if (this.scope === previous) this.scope = next; }

  start(taskId: number): SessionDraft {
    return this.open({ taskId, sessionId: null });
  }

  adopt({ scopeId, taskId, sessionId }: ChatSelection, draft: SessionDraft): void {
    this.selectScope(scopeId);
    const existing = this.entries.get(sessionId);
    // A revision read may expose the saved row before the create reply arrives.
    // Keep that entry's live sends and attachments, merging any earlier local writing.
    if (existing && existing !== draft) {
      existing.mergeCreation(draft);
      return;
    }
    this.evict();
    draft.promote({ taskId, sessionId });
    this.entries.set(sessionId, draft);
  }

  entry({ scopeId, taskId, sessionId }: ChatSelection): SessionDraft {
    this.selectScope(scopeId);
    const existing = this.entries.get(sessionId);
    if (existing) {
      this.entries.delete(sessionId);
      this.entries.set(sessionId, existing);
      return existing;
    }
    this.evict();
    const entry = this.open({ taskId, sessionId });
    this.entries.set(sessionId, entry);
    return entry;
  }

  private selectScope(scope: string): void {
    if (this.scope !== scope) {
      this.scope = scope;
      this.entries.clear(); this.snapshots.clear();
    }
  }

  private evict(): void {
    for (const [id, draft] of this.entries) {
      if (this.entries.size < 20) break;
      if (!draft.uncertain() && !draft.delivery() && !draft.retained().some(write => write.files?.length || write.mentions?.length) && !draft.hasUnsavedText()) this.entries.delete(id);
    }
  }

  private open(target: SessionChatDraftTarget): SessionDraft {
    const entry = new SessionDraft(), environment = this.environment;
    // Isolated component previews also work without a desktop draft store.
    if (environment && typeof this.bridge?.sessionChatDraftRead === 'function' && typeof this.bridge.sessionChatDraftSave === 'function') {
      entry.bind({ bridge: this.bridge, environment, target, readTarget: target, current: () => this.environment === environment });
    }
    return entry;
  }
}
