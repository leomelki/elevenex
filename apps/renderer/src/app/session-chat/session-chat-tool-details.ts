import { Injectable, computed, signal, type WritableSignal } from '@angular/core';
import type { SessionChatRecord, SessionChatToolSource } from '@elevenex/shared';
import type { SessionChatClient } from '../backend/session-chat-client.service';
import type { ToolDetailsInspection, ToolDetailsProvider, ToolDetailsState, ToolEvidence } from '../conversation';
import { ChatDisclosureCache } from './session-chat-disclosure-cache';
import { presentSessionToolEvidence, sessionToolDetailsSource } from './session-chat-tools';
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
  pending?: Promise<void>;
}

function keyFor(selection: ChatSelection, source: SessionChatToolSource): string {
  const { item, result } = source;
  return JSON.stringify([selection.taskId, selection.sessionId, source.turnId, item.id, item.revision, result?.id, result?.revision]);
}

/** A mounted conversation owns only the details currently being inspected. */
export class SessionChatToolDetails {
  private readonly selection = signal<ChatSelection | null>(null);
  private readonly open = new Map<string, Inspection>();
  /** At most one unobserved read warmed by hover, focus or press intent. */
  private speculative?: Inspection;
  private available = false;
  readonly provider = computed<ToolDetailsProvider | undefined>(() => {
    const selection = this.selection();
    return selection ? Object.assign(
      (source: SessionChatToolSource, signal: AbortSignal) => this.observe(selection, source, signal),
      { prefetch: (source: SessionChatToolSource) => this.prefetch(selection, source) },
    ) : undefined;
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
    this.speculative = undefined;
    this.selection.set(selection);
  }

  setAvailable(available: boolean): void {
    if (available === this.available) return;
    this.available = available;
    for (const entry of this.open.values()) {
      const state = entry.state();
      if (!available && !entry.observers) this.discard(entry);
      else if (!available && entry.request) {
        this.cancel(entry);
        entry.state.set(unavailable);
      } else if (available && state.status === 'error' && state.reason === 'unavailable') {
        this.load(entry);
      }
    }
  }

  /** Stage only rows whose details were already open. Mounted tools take
   * over these observers when the complete turn is revealed. */
  async prepare(items: readonly SessionChatRecord[], toolIds: readonly string[], signal: AbortSignal, turnId?: string): Promise<void> {
    const selection = this.selection();
    if (!selection || signal.aborted) return;
    const wanted = new Set(toolIds);
    const results = new Map(items.filter(row => row.kind === 'tool_result').map(row => [row.toolId ?? row.id, row]));
    const sources = items.flatMap(row => {
      const source = wanted.has(row.id) ? sessionToolDetailsSource(row, results.get(row.toolId ?? row.id), turnId) : undefined;
      return source ? [source] : [];
    });
    const queue = sources.values();
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      for (const source of queue) {
        if (signal.aborted) return;
        const entry = this.retain(selection, source, signal);
        await entry?.pending;
      }
    }));
  }

  /** Warm one closed tool into the cache. A newer intent supersedes an unobserved read. */
  private prefetch(selection: ChatSelection, source: SessionChatToolSource): void {
    if (!this.available || this.selection() !== selection) return;
    const key = keyFor(selection, source);
    if (this.open.has(key) || this.cache.get(selection.scopeId, key)) return;
    if (this.speculative) this.discard(this.speculative);
    const entry: Inspection = { selection, source, key, observers: 0, state: signal<ToolDetailsState>(unavailable) };
    this.open.set(key, entry);
    this.speculative = entry;
    this.load(entry);
  }

  private discard(entry: Inspection): void {
    if (this.open.get(entry.key) === entry) this.open.delete(entry.key);
    if (this.speculative === entry) this.speculative = undefined;
    this.cancel(entry);
  }

  private observe(selection: ChatSelection, source: SessionChatToolSource, signalToRelease: AbortSignal): ToolDetailsInspection {
    const inspection = this.retain(selection, source, signalToRelease);
    if (!inspection) return closed;
    return {
      state: inspection.state.asReadonly(),
      retry: () => {
        if (signalToRelease.aborted || this.open.get(inspection.key) !== inspection) return;
        const state = inspection.state();
        if (state.status !== 'error') return;
        if (state.reason === 'changed') this.refresh();
        else this.load(inspection);
      },
    };
  }

  private retain(selection: ChatSelection, source: SessionChatToolSource, signalToRelease: AbortSignal): Inspection | undefined {
    if (signalToRelease.aborted || this.selection() !== selection) return;
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
    // An observer adopts a warmed read, so the next intent cannot cancel it.
    if (this.speculative === inspection) this.speculative = undefined;
    inspection.observers++;
    signalToRelease.addEventListener('abort', () => {
      inspection.observers--;
      if (inspection.observers || this.open.get(key) !== inspection) return;
      this.open.delete(key);
      this.cancel(inspection);
    }, { once: true });
    return inspection;
  }

  private load(entry: Inspection): void {
    if (!this.available || entry.request) return;
    const requestId = crypto.randomUUID();
    entry.request = requestId;
    entry.state.set(loading);
    entry.pending = this.receive(entry, requestId);
  }

  private async receive(entry: Inspection, requestId: string): Promise<void> {
    const { selection, source, key } = entry;
    const result = await this.client.toolDetails(selection.scopeId, {
      taskId: selection.taskId, sessionId: selection.sessionId, ...source, requestId,
    });
    if (this.open.get(key) !== entry || entry.request !== requestId || this.selection() !== selection) return;
    entry.request = undefined;
    entry.pending = undefined;
    // An unobserved warm-up leaves only its cached evidence. A failure stays
    // uncached, so an explicit open reads again.
    if (!entry.observers) this.discard(entry);
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
    entry.pending = undefined;
  }
}
