import { randomUUID } from 'node:crypto';
import type {
  BrowserHumanElement,
  BrowserHumanRequest,
} from '@elevenex/shared';

/** Task-owned tickets outlive code workers. Only the owning session reads a
 * result; only trusted viewer commands complete it and return page authority. */
export class BrowserInteractions {
  private readonly requests = new Map<string, BrowserHumanRequest>();
  private closed = false;
  constructor(private readonly changed: () => void) {}
  create(
    sessionId: number,
    tabId: string,
    kind: 'action' | 'element',
    message: string,
  ): BrowserHumanRequest {
    this.expire();
    if (this.closed || this.pending().length >= 4)
      throw new Error('Browser human-request capacity reached');
    if (!message.trim() || message.length > 2000)
      throw new Error('Human request message must contain 1–2000 characters');
    if (this.pending().some((request) => request.tabId === tabId))
      throw new Error('This page already has a human request');
    if (this.requests.size >= 32) {
      const old = [...this.requests.values()].find(
        (request) => request.status !== 'pending',
      );
      if (!old) throw new Error('Human request history is full');
      this.requests.delete(old.id);
    }
    const request: BrowserHumanRequest = {
      id: randomUUID(),
      sessionId,
      tabId,
      kind,
      message,
      status: 'pending',
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    this.requests.set(request.id, request);
    this.changed();
    return request;
  }
  pending(): readonly BrowserHumanRequest[] {
    this.expire();
    return [...this.requests.values()].filter(
      (request) => request.status === 'pending',
    );
  }
  get(id: string, sessionId?: number): BrowserHumanRequest {
    this.expire();
    const request = this.requests.get(id);
    if (
      !request ||
      (sessionId !== undefined && request.sessionId !== sessionId)
    )
      throw new Error('Human request is unavailable to this conversation');
    return request;
  }
  complete(id: string, selection?: BrowserHumanElement): BrowserHumanRequest {
    const request = this.get(id);
    if (request.status !== 'pending')
      throw new Error('Human request already resolved');
    selection ??= request.selection;
    if (request.kind === 'element' && !selection)
      throw new Error('Select an element before completing this request');
    const resolved = {
      ...request,
      status: 'completed' as const,
      ...(selection ? { selection } : {}),
    };
    this.requests.set(id, resolved);
    this.changed();
    return resolved;
  }
  select(id: string, selection: BrowserHumanElement): void {
    const request = this.get(id);
    if (request.kind !== 'element' || request.status !== 'pending')
      throw new Error('Element request changed');
    this.requests.set(id, { ...request, selection });
    this.changed();
  }
  results(): readonly BrowserHumanRequest[] {
    this.expire();
    return [...this.requests.values()];
  }
  cancel(id: string, sessionId?: number): BrowserHumanRequest {
    const request = this.get(id, sessionId);
    if (request.status !== 'pending') return request;
    const resolved = { ...request, status: 'cancelled' as const };
    this.requests.set(id, resolved);
    this.changed();
    return resolved;
  }
  cancelPage(tabId: string): void {
    for (const request of this.pending())
      if (request.tabId === tabId) this.cancel(request.id);
  }
  private expire(): void {
    let changed = false;
    for (const [id, request] of this.requests)
      if (request.status === 'pending' && Date.now() >= request.expiresAt) {
        this.requests.set(id, { ...request, status: 'expired' });
        changed = true;
      }
    if (changed && !this.closed) this.changed();
  }
  dispose(): void {
    this.closed = true;
    this.requests.clear();
  }
}
