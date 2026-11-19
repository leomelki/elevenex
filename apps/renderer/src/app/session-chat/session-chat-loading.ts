import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import type { SessionChatRead } from '@elevenex/shared';
import { BackendClientService } from '../backend/backend-client.service';

/** Rollout flag. Slow initial reads can enable the app's connection-wide fallback. */
export const SESSION_CHAT_PROGRESSIVE_LOADING = new InjectionToken<boolean>(
  'Progressive conversation loading', { providedIn: 'root', factory: () => false },
);

export const SESSION_CHAT_SLOW_OPEN_MS = 1750;

/** Shared by every chat in the Angular application, never persisted with a draft.
 * Backend scope IDs rotate on reconnect/restart, so the old connection's slow
 * read cannot enable or retain progressive loading on the new connection. */
@Injectable({ providedIn: 'root' })
export class SessionChatLoadingPolicy {
  private readonly backend = inject(BackendClientService);
  private readonly enabledByDefault = inject(SESSION_CHAT_PROGRESSIVE_LOADING);
  private readonly slowScope = signal<string | null>(null);
  readonly progressive = computed(() => this.enabledByDefault ||
    (!!this.slowScope() && this.slowScope() === this.backend.state().scope?.id));
  readonly profile = computed<Required<Pick<SessionChatRead, 'loadingMode'>> & Pick<SessionChatRead, 'summarizeCompleted'>>(
    () => this.progressive() ? { loadingMode: 'progressive', summarizeCompleted: true } : { loadingMode: 'window' },
  );

  enableProgressive(scopeId: string): boolean {
    if (!scopeId || this.backend.state().scope?.id !== scopeId) return false;
    this.slowScope.set(scopeId);
    return true;
  }
}
