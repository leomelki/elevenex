import { signal } from '@angular/core';
import type { SessionChatCatalog } from '@elevenex/shared';
import type { SessionChatClient } from '../backend/session-chat-client.service';
import type { ChatSelection } from './session-chat.store';

/** One selected harness's catalog, independent of whether its session has run. */
export class SessionChatModels {
  readonly value = signal<SessionChatCatalog | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  private pending: { readonly scopeId: string; readonly requestId: string } | null = null;

  constructor(private readonly client: Pick<SessionChatClient, 'catalog' | 'cancel'>) {}

  reset(): void {
    if (this.pending) this.client.cancel(this.pending.scopeId, this.pending.requestId);
    this.pending = null;
    this.loading.set(false);
    this.error.set('');
    this.value.set(null);
  }

  async load(selection: ChatSelection, provider: string, refresh = false): Promise<void> {
    if (this.pending) return;
    const pending = { scopeId: selection.scopeId, requestId: crypto.randomUUID() };
    this.pending = pending;
    this.loading.set(true);
    this.error.set('');
    const result = await this.client.catalog(selection.scopeId, {
      taskId: selection.taskId, sessionId: selection.sessionId, provider,
      requestId: pending.requestId, ...(refresh ? { refresh: true } : {}),
    });
    if (this.pending !== pending) return;
    this.pending = null;
    this.loading.set(false);
    if (!result.ok) {
      this.error.set(result.error.message);
    } else if (result.value.provider === provider) {
      this.value.set(result.value);
      this.error.set(result.value.error ?? (result.value.models.length ? '' : 'This harness has not reported any models. Refresh models to try again.'));
    } else {
      this.error.set('The harness changed. Refresh models to try again.');
    }
  }
}
