import type {
  BrowserHumanCommand,
  BrowserHumanRequest,
} from '@elevenex/shared';
import type { BrowserAgentTarget } from './host.js';
import { BrowserInteractions } from './interactions.js';
import {
  pickBrowserElement,
  validateBrowserSelection,
  validatePickedBrowserElement,
} from './element-picker.js';

export interface InteractionTab {
  readonly documentId: string;
  readonly ownership: number;
  readonly picking?: boolean;
  assertAgent(sessionId: number): void;
  takeOver(): void;
  handBack(sessionId: number): void;
  select(): void | Promise<void>;
  picker(callback: ((x: number, y: number) => Promise<void>) | null): void;
  pause(paused: boolean): void;
  target(current: () => boolean): Promise<BrowserAgentTarget>;
}
export interface InteractionHost {
  tab(id: string): InteractionTab;
  authorize(sessionId: number): Promise<void>;
  changed(): void;
  version?: string;
}
/** One task owns requests and the selection lifecycle, independently of code
 * worker resets. Viewer confirmation is the only path that returns control. */
export class BrowserInteractionController {
  private readonly store: BrowserInteractions;
  private readonly picking = new Map<string, { id: string; busy: boolean }>();
  private disposed = false;
  private readonly resources = new Map<string, BrowserHumanRequest>();
  constructor(private readonly host: InteractionHost) {
    this.store = new BrowserInteractions(() => host.changed());
  }
  get pending(): readonly BrowserHumanRequest[] {
    const pending = this.store.pending();
    for (const [id, request] of this.resources)
      if (!pending.some((row) => row.id === id)) this.stopPicker(request);
    return pending;
  }
  get results(): readonly BrowserHumanRequest[] {
    return this.store
      .results()
      .map((request) =>
        request.status !== 'completed' && request.selection
          ? { ...request, selection: undefined }
          : request,
      );
  }
  get(id: string, sessionId?: number): BrowserHumanRequest {
    return this.store.get(id, sessionId);
  }
  async execute(
    sessionId: number,
    command: BrowserHumanCommand,
  ): Promise<BrowserHumanRequest> {
    if (this.disposed) throw new Error('Browser task closed');
    if (command.kind === 'request') {
      const tab = this.host.tab(command.tabId);
      tab.assertAgent(sessionId);
      const request = this.store.create(
        sessionId,
        command.tabId,
        command.requestKind,
        command.message,
      );
      this.resources.set(request.id, request);
      tab.takeOver();
      this.host.changed();
      return request;
    }
    const request = this.store.get(command.requestId, sessionId);
    if (command.kind === 'cancel') {
      this.stopPicker(request);
      return this.store.cancel(request.id, sessionId);
    }
    if (
      request.status === 'completed' &&
      request.selection &&
      this.host.tab(request.tabId).documentId !== request.selection.documentId
    )
      throw new Error('The selected document changed; ask for a fresh element');
    // A selection awaiting confirmation is shown to the person, not yet shared
    // with the requesting agent.
    return request.status !== 'completed' && request.selection
      ? { ...request, selection: undefined }
      : request;
  }
  async viewer(
    kind:
      | 'agent-request-complete'
      | 'agent-request-cancel'
      | 'agent-request-pick',
    id: string,
  ): Promise<void> {
    const request = this.store.get(id);
    if (kind === 'agent-request-cancel') {
      this.stopPicker(request);
      this.store.cancel(id);
      return;
    }
    if (request.status !== 'pending')
      throw new Error('Human request already resolved');
    const tab = this.host.tab(request.tabId);
    if (kind === 'agent-request-pick') {
      if (request.kind !== 'element')
        throw new Error('This is an action request');
      await tab.select();
      tab.takeOver();
      tab.pause(false);
      const state = { id, busy: false };
      this.picking.set(request.tabId, state);
      tab.picker(async (x, y) => {
        if (state.busy) return;
        state.busy = true;
        const documentId = tab.documentId,
          ownership = tab.ownership;
        const current = () =>
          !this.disposed &&
          this.picking.get(request.tabId) === state &&
          this.store.get(id).status === 'pending' &&
          tab.documentId === documentId &&
          tab.ownership === ownership &&
          tab.picking !== false;
        try {
          const target = await tab.target(current);
          const selection = await pickBrowserElement(
            target,
            x,
            y,
            documentId,
            current,
            this.host.version,
          );
          if (!current()) throw new Error('Selection changed');
          this.store.select(id, selection);
          tab.picker(null);
          tab.pause(true);
          this.picking.delete(request.tabId);
          this.host.changed();
        } finally {
          state.busy = false;
        }
      });
      this.host.changed();
      return;
    }
    const ownership = tab.ownership;
    if (
      request.kind === 'element' &&
      (!request.selection || request.selection.documentId !== tab.documentId)
    )
      throw new Error('Select an element in the current document first');
    await this.host.authorize(request.sessionId);
    if (request.selection)
      await validateBrowserSelection(
        await tab.target(
          () =>
            !this.disposed &&
            this.store.get(id).status === 'pending' &&
            tab.ownership === ownership,
        ),
        request.selection,
      );
    if (request.selection) {
      const selectedDocument = request.selection.documentId;
      const current = () =>
        !this.disposed &&
        this.store.get(id).status === 'pending' &&
        tab.ownership === ownership &&
        tab.documentId === selectedDocument;
      await validatePickedBrowserElement(
        await tab.target(current),
        request.selection,
        current,
        this.host.version,
      );
    }
    if (
      this.disposed ||
      this.store.get(id).status !== 'pending' ||
      tab.ownership !== ownership ||
      (request.selection && request.selection.documentId !== tab.documentId)
    )
      throw new Error('Browser control changed while authorizing the return');
    this.stopPicker(request);
    this.store.complete(id);
    tab.handBack(request.sessionId);
    this.host.changed();
  }
  private stopPicker(request: BrowserHumanRequest): void {
    this.picking.delete(request.tabId);
    this.resources.delete(request.id);
    try {
      const tab = this.host.tab(request.tabId);
      tab.picker(null);
      tab.pause(false);
    } catch {
      /* Tab already closed. */
    }
  }
  pageClosed(id: string): void {
    this.store.cancelPage(id);
    const state = this.picking.get(id);
    if (state) this.picking.delete(id);
  }
  dispose(): void {
    this.disposed = true;
    for (const request of this.store.pending()) this.stopPicker(request);
    this.store.dispose();
    this.picking.clear();
  }
}
