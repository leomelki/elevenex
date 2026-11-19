import { Injectable, computed, signal, type WritableSignal } from '@angular/core';
import type { SessionChatToolSource } from '@elevenex/shared';
import type { SessionChatClient } from '../backend/session-chat-client.service';
import type { ToolDetailsInspection, ToolDetailsProvider, ToolDetailsState, ToolEvidence } from '../conversation';
import { ChatDisclosureCache } from './session-chat-disclosure-cache';
import { presentSessionToolEvidence } from './session-chat-tools';
import type { ChatSelection } from './session-chat.store';

const loading = { status: 'loading' } as const;
const unavailable = { status: 'error', reason: 'unavailable' } as const;
const closed: ToolDetailsInspection = { state: signal<ToolDetailsState>(unavailable).asReadonly(), retry: () => undefined };

@Injectable({ providedIn: 'root' })
export class SessionChatToolCache extends ChatDisclosureCache<ToolEvidence> {
  constructor() { super(48, 1024 * 1024); }
}

interface Inspection {
  readonly selection: ChatSelection;
  readonly source: SessionChatToolSource;
  readonly key: string;
  readonly state: WritableSignal<ToolDetailsState>;
  observers: number;
  request?: string;
}

function keyFor(selection: ChatSelection, source: SessionChatToolSource): string {
  const { item, result } = source;
  return JSON.stringify([selection.taskId, selection.sessionId, item.id, item.revision, result?.id, result?.revision]);
}

/** A mounted conversation owns only the details currently being inspected. */
export class SessionChatToolDetails {
  private readonly selection = signal<ChatSelection | null>(null);
  private readonly open = new Map<string, Inspection>();
  private available = false;
  readonly provider = computed<ToolDetailsProvider | undefined>(() => {
    const selection = this.selection();
    return selection ? (source, signal) => this.observe(selection, source, signal) : undefined;
  });

  constructor(
    private readonly client: Pick<SessionChatClient, 'toolDetails' | 'cancel'>,
    private readonly cache: SessionChatToolCache,
    private readonly refresh: () => void,
  ) {}

  select(selection: ChatSelection | null): void {
    for (const entry of this.open.values()) {
      this.cancel(entry);
      entry.state.set(unavailable);
    }
    this.open.clear();
    this.selection.set(selection);
  }

  setAvailable(available: boolean): void {
    if (available === this.available) return;
    this.available = available;
    for (const entry of this.open.values()) {
      const state = entry.state();
      if (!available && entry.request) {
        this.cancel(entry);
        entry.state.set(unavailable);
      } else if (available && state.status === 'error' && state.reason === 'unavailable') {
        this.load(entry);
      }
    }
  }

  private observe(selection: ChatSelection, source: SessionChatToolSource, signalToRelease: AbortSignal): ToolDetailsInspection {
    if (signalToRelease.aborted || this.selection() !== selection) return closed;
    const key = keyFor(selection, source);
    let entry = this.open.get(key);
    if (!entry) {
      const evidence = this.cache.get(selection.scopeId, key);
      entry = { selection, source, key, observers: 0,
        state: signal<ToolDetailsState>(evidence ? { status: 'ready', evidence } : unavailable) };
      this.open.set(key, entry);
      if (!evidence) this.load(entry);
    }
    const inspection = entry;
    inspection.observers++;
    signalToRelease.addEventListener('abort', () => {
      inspection.observers--;
      if (inspection.observers || this.open.get(key) !== inspection) return;
      this.open.delete(key);
      this.cancel(inspection);
    }, { once: true });
    return {
      state: inspection.state.asReadonly(),
      retry: () => {
        if (signalToRelease.aborted || this.open.get(key) !== inspection) return;
        const state = inspection.state();
        if (state.status !== 'error') return;
        if (state.reason === 'changed') this.refresh();
        else this.load(inspection);
      },
    };
  }

  private load(entry: Inspection): void {
    if (!this.available || entry.request) return;
    const requestId = crypto.randomUUID();
    entry.request = requestId;
    entry.state.set(loading);
    void this.receive(entry, requestId);
  }

  private async receive(entry: Inspection, requestId: string): Promise<void> {
    const { selection, source, key } = entry;
    const result = await this.client.toolDetails(selection.scopeId, {
      taskId: selection.taskId, sessionId: selection.sessionId, ...source, requestId,
    });
    if (this.open.get(key) !== entry || entry.request !== requestId || this.selection() !== selection) return;
    entry.request = undefined;
    if (!result.ok) {
      entry.state.set({ status: 'error', reason: result.error.status === 409 ? 'changed' : 'failed' });
      return;
    }
    const value = result.value;
    if (value.taskId !== selection.taskId || value.sessionId !== selection.sessionId || keyFor(selection, value) !== key) {
      entry.state.set({ status: 'error', reason: 'changed' });
      return;
    }
    const evidence = presentSessionToolEvidence(value.item.record, value.result?.record);
    this.cache.put(selection.scopeId, key, evidence);
    entry.state.set({ status: 'ready', evidence });
  }

  private cancel(entry: Inspection): void {
    if (entry.request) this.client.cancel(entry.selection.scopeId, entry.request);
    entry.request = undefined;
  }
}
