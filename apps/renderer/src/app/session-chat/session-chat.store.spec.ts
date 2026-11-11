import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendResult,
  ElevenexBridge,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "../backend/backend-client.service";
import { createSessionDraft, type StartingSession, SessionChatDrafts } from "./session-chat-drafts";
import { SessionChatStore } from "./session-chat.store";
import { chatExchanges } from "./session-chat-transcript";
const state: SessionChatState = {
  provider: "codex",
  phase: "idle",
  canInterrupt: false,
  error: null,
  model: null,
  models: [],
  reasoning: null,
  plan: false,
  permissionMode: null,
  permissionModes: [],
  context: null,
  queue: [],
  queuePaused: false,
  permission: null,
  question: null,
  activity: [],
};
const item = (
  id: string,
  kind: SessionChatItem["kind"],
  text: string,
  extra: Partial<SessionChatItem> = {},
): SessionChatItem => ({
  id,
  kind,
  text,
  timestamp: "2026-10-28T12:00:00Z",
  toolId: null,
  toolName: null,
  toolKind: null,
  input: "",
  error: false,
  truncated: false,
  ...extra,
});
const page = (
  sessionId = 2,
  patch: Partial<SessionChatPage> = {},
): SessionChatPage => ({
  taskId: 1,
  sessionId,
  reset: true,
  cursor: "cursor",
  before: null,
  items: [],
  events: [],
  state,
  ...patch,
});
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  const scope = signal({
    revision: 1,
    scope: { id: "scope", environment: { kind: "local" as const } },
  });
  const bridge = {
    sessionChatRead: vi.fn(async (_scope, input) => ok(page(input.sessionId))),
    sessionChatCommand: vi.fn(async () => ok({ accepted: true as const })),
    sessionChatCancel: vi.fn(async () => undefined),
  } satisfies Pick<
    ElevenexBridge,
    "sessionChatRead" | "sessionChatCommand" | "sessionChatCancel"
  >;
  TestBed.configureTestingModule({
    providers: [
      SessionChatStore,
      SessionChatDrafts,
      { provide: ELEVENEX_BRIDGE, useValue: bridge },
      { provide: BackendClientService, useValue: { state: scope } },
    ],
  });
  const store = TestBed.inject(SessionChatStore);
  store.open({ scopeId: "scope", taskId: 1, sessionId: 2 }, false);
  return { store, bridge, scope };
}

it('retains conversation inputs on idle heartbeats and keeps transient poll failures quiet', async () => {
  const { store, bridge } = setup(); await settle();
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [item('prompt', 'user', 'Keep this conversation')] })));
  await store.refresh();
  const exchanges = store.exchanges(), items = store.items(), previousState = store.state();
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: false, state: structuredClone(state) })));
  await vi.advanceTimersByTimeAsync(80);
  expect(store.exchanges()).toBe(exchanges);
  expect(store.items()).toBe(items);
  expect(store.state()).toBe(previousState);
  expect(store.loading()).toBe(false);
  bridge.sessionChatRead.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Temporary failure' } });
  await vi.advanceTimersByTimeAsync(80);
  expect(store.error()).toBe('');
  expect(store.exchanges()).toBe(exchanges);
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: false, events: [{ type: 'item', item: item('answer', 'assistant', 'New output still arrives') }] })));
  await vi.advanceTimersByTimeAsync(3000);
  expect(store.exchanges()[0]?.answer).toBe('New output still arrives');
  bridge.sessionChatRead.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Explicit failure' } });
  await store.refresh();
  expect(store.error()).toBe('Explicit failure');
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("session chat ownership", () => {
  it.each(['idle', 'running'] as const)('keeps HTTP read failures quiet while %s and resumes from the same cursor', async (phase) => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      items: [item('prompt', 'user', 'Existing prompt')], state: { ...state, phase },
    })));
    await store.refresh();
    store.setDraft('Next thought');
    const exchanges = store.exchanges(), previousState = store.state();
    for (const status of [500, 502, 503]) {
      bridge.sessionChatRead.mockResolvedValueOnce({ ok: false, error: { code: 'http', status, message: 'Backend request failed.' } });
      await vi.advanceTimersByTimeAsync(status === 500 ? 80 : 3000);
      expect(store.error()).toBe('');
      expect(store.loading()).toBe(false);
      expect(store.uncertain()).toBe('');
      expect(store.exchanges()).toBe(exchanges);
      expect(store.state()).toBe(previousState);
      expect(store.draft()).toBe('Next thought');
    }
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      reset: false, events: [{ type: 'item', item: item('answer', 'assistant', 'Recovered output') }],
    })));
    await vi.advanceTimersByTimeAsync(3000);
    expect(bridge.sessionChatRead.mock.lastCall?.[1].after).toBe('cursor');
    expect(store.exchanges()[0]?.answer).toBe('Recovered output');
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });

  it('allows local writing without reads or sends, then hands off the same draft and view to the saved session', async () => {
    const { store, bridge } = setup(); await settle();
    const draft = createSessionDraft();
    const starting: StartingSession = { id: 'local-draft', scopeId: 'scope', taskId: 1, draft, status: 'creating' };
    const reads = bridge.sessionChatRead.mock.calls.length;
    store.openDraft(starting);
    const revision = store.viewRevision();
    store.setDraft('Written before creation');
    await store.submit({ text: store.draft(), intent: 'send', context: [] });
    expect(store.draft()).toBe('Written before creation'); expect(store.exchanges()).toEqual([]);
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled(); expect(bridge.sessionChatRead).toHaveBeenCalledTimes(reads);
    const read = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockImplementationOnce(() => read.promise);
    TestBed.inject(SessionChatDrafts).adopt('scope', 20, draft);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 20 }, false);
    expect(store.viewRevision()).toBe(revision); expect(store.starting()).toBe(true);
    store.setDraft('Still writing during hydration');
    read.resolve(ok(page(20))); await settle();
    expect(store.starting()).toBe(false); expect(store.compactStart()).toBe(true);
    expect(store.draft()).toBe('Still writing during hydration');
    await store.submit({ text: store.draft(), intent: 'send', context: [] });
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith('scope', expect.objectContaining({ sessionId: 20, action: expect.objectContaining({ type: 'send', text: 'Still writing during hydration' }) }));
  });

  it('updates a retained local draft’s scope after same-machine recovery without loading or sending', async () => {
    const { store, bridge, scope } = setup(); await settle();
    const starting: StartingSession = { id: 'local-draft', scopeId: 'scope', taskId: 1, draft: createSessionDraft(), status: 'creating' };
    store.openDraft(starting); store.setDraft('Keep writing through recovery');
    scope.set({ revision: 2, scope: { id: 'next', environment: { kind: 'local' } } });
    store.openDraft({ ...starting, scopeId: 'next', status: 'unknown' });
    expect(store.offline()).toBe(false); expect(store.draft()).toBe('Keep writing through recovery');
    await store.submit({ text: store.draft(), intent: 'send', context: [] });
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });

  it('cancels the old conversation read and rejects its late reply after opening a local draft', async () => {
    const { store, bridge } = setup(); await settle();
    const read = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockImplementationOnce(() => read.promise);
    const refreshing = store.refresh();
    const starting: StartingSession = { id: 'local-draft', scopeId: 'scope', taskId: 1, draft: createSessionDraft(), status: 'creating' };
    store.openDraft(starting); store.setDraft('Safe local writing');
    read.resolve(ok(page(2, { items: [item('late', 'assistant', 'Old conversation')] }))); await refreshing;
    expect(bridge.sessionChatCancel).toHaveBeenCalled();
    expect(store.items()).toEqual([]); expect(store.state()).toBeNull(); expect(store.draft()).toBe('Safe local writing');
    store.openDraft({ ...starting, status: 'failed' });
    expect(store.draft()).toBe('Safe local writing');
  });

  it('reconciles a successful send quietly without replaying it when the following read fails', async () => {
    const { store, bridge } = setup(); await settle();
    const read = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockReturnValueOnce(read.promise);
    await store.submit({ text: 'Delivered prompt', intent: 'send', context: [] });
    expect(store.loading()).toBe(false);
    expect(bridge.sessionChatRead.mock.lastCall?.[1].after).toBe('cursor');
    read.resolve({ ok: false, error: { code: 'http', status: 503, message: 'Backend request failed.' } });
    await settle();
    expect(store.error()).toBe('');
    expect(store.uncertain()).toBe('');
    expect(store.draft()).toBe('');
    expect(store.exchanges().at(-1)?.prompt).toBe('Delivered prompt');
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      reset: false, events: [{ type: 'item', item: item('receipt', 'user', 'Delivered prompt') }],
    })));
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.exchanges().map(exchange => exchange.id)).toEqual(['receipt']);
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  });

  it('shares an active background read across repeated visibility notifications', async () => {
    const { bridge } = setup(); await settle();
    const read = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(80);
    for (let i = 0; i < 3; i++) document.dispatchEvent(new Event('visibilitychange'));
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(2);
    read.resolve(ok(page(2, { reset: false })));
    await settle();
    await vi.advanceTimersByTimeAsync(80);
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(3);
  });

  it('still exposes missing-chat and rejected-send errors', async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 404, message: 'Missing chat' } });
    await vi.advanceTimersByTimeAsync(80);
    expect(store.error()).toContain('Chat is unavailable');
    bridge.sessionChatCommand.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 503, message: 'Backend request failed.' } });
    await store.submit({ text: 'Rejected prompt', intent: 'send', context: [] });
    expect(store.error()).toBe('Backend request failed.');
    expect(store.draft()).toBe('Rejected prompt');
  });

  it("preserves the paired arrival when a saved receipt beats the first painted optimistic turn", async () => {
    const { store, bridge } = setup();
    await settle();
    const sendOrigin = { left: 20, top: 400, at: performance.now() };
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      items: [item("immediate", "user", "Start together"), item("reply", "assistant", "Checking")],
      state: { ...state, phase: "running", canInterrupt: true },
    })));
    await store.submit({ text: "Start together", intent: "send", context: [], sendOrigin });
    await settle();
    // No intermediate exchanges() read or renderer paint before the receipt.
    expect(store.exchanges().at(-1)).toMatchObject({
      id: "immediate", isNew: true, sendOrigin, status: "live",
    });
    expect(store.exchanges().at(-1)?.renderId).toMatch(/^local-/);
    expect(JSON.stringify(bridge.sessionChatCommand.mock.calls)).not.toContain("sendOrigin");
  });

  it("keeps queue render identities through receipts while actions use durable IDs", async () => {
    const { store, bridge } = setup(); await settle();
    const existing = { id: "existing", text: "Repeat this" };
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { state: { ...state, queue: [existing] } })));
    await store.refresh();
    await store.submit({ text: "Repeat this", intent: "queue", context: [] });
    const temporaryId = store.queue().at(-1)!.id;
    const receipt = { id: "durable", text: "Repeat this" };
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { state: { ...state, queue: [existing, receipt] } })));
    await store.refresh();
    expect(store.queue()).toEqual([existing, { ...receipt, renderId: temporaryId }]);
    // Subsequent reads and position changes must retain the same mounted row.
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { state: { ...state, queue: [receipt, existing] } })));
    await store.refresh();
    expect(store.queue()[0]?.renderId).toBe(temporaryId);
    await store.perform({ type: "cancel-queued", id: store.queue()[0]!.id });
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", {
      taskId: 1, sessionId: 2, action: { type: "cancel-queued", id: "durable" },
    });
  });

  it.each(["removal", "navigation"] as const)("releases reconciled queue identities after %s", async boundary => {
    const { store, bridge } = setup(); await settle();
    await store.submit({ text: "Follow up", intent: "queue", context: [] });
    const temporaryId = store.queue()[0]!.id;
    const receipt = { id: "durable", text: "Follow up" };
    const received = () => ok(page(2, { state: { ...state, queue: [receipt] } }));
    bridge.sessionChatRead.mockResolvedValueOnce(received());
    await store.refresh();
    expect(store.queue()[0]?.renderId).toBe(temporaryId);
    if (boundary === "removal") {
      bridge.sessionChatRead.mockResolvedValueOnce(ok(page()));
      await store.refresh();
    } else {
      store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, false);
      await settle();
      store.open({ scopeId: "scope", taskId: 1, sessionId: 2 }, false);
      await settle();
    }
    bridge.sessionChatRead.mockResolvedValueOnce(received());
    await store.refresh();
    expect(store.queue()).toEqual([receipt]);
  });

  it.each(["paging", "navigation"] as const)("releases reconciled turn identities after %s", async boundary => {
    const { store, bridge } = setup(); await settle();
    const sendOrigin = { left: 20, top: 400, at: performance.now() };
    await store.submit({ text: "Hi", intent: "send", context: [], sendOrigin });
    const temporaryId = store.exchanges().at(-1)!.id;
    const receipt = item("durable", "user", "Hi");
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [receipt] })));
    await store.refresh();
    expect(store.exchanges().at(-1)?.id).toBe("durable");
    expect(store.exchanges().at(-1)?.renderId).toBe(temporaryId);
    expect(store.exchanges().at(-1)?.sendOrigin).toBe(sendOrigin);
    expect(store.exchanges().at(-1)?.isNew).toBe(true);
    if (boundary === "paging") {
      bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
        reset: false,
        events: Array.from({ length: 320 }, (_, i) => ({ type: "item" as const, item: item(`later-${i}`, "system", "Later record") })),
      })));
      await store.refresh();
      expect(store.items().some(item => item.id === "durable")).toBe(false);
    } else {
      store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, false);
      await settle();
      bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [receipt] })));
      store.open({ scopeId: "scope", taskId: 1, sessionId: 2 }, false);
      await settle();
    }
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [receipt] })));
    await store.refresh();
    expect(store.exchanges().at(-1)?.id).toBe("durable");
    expect(store.exchanges().at(-1)?.renderId).toBeUndefined();
    expect(store.exchanges().at(-1)?.sendOrigin).toBeUndefined();
    expect(store.exchanges().at(-1)?.isNew).toBe(false);
  });
  it('shows session mentions optimistically and restores their durable identities after reopening history', async () => {
    const { store, bridge } = setup(); await settle();
    store.state.update(value => value && ({ ...value, sessionMentions: true }));
    const mention = { id: '12', kind: 'session' as const, label: 'Other work' };
    store.addMention(mention); store.setDraft('Compare');
    const reply = deferred<BackendResult<{ accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(reply.promise);
    const sending = store.submit({ text: 'Compare', intent: 'send', context: [mention] });
    expect(store.exchanges()[0]?.mentions).toEqual([mention]);
    expect(store.mentions()).toEqual([]);
    bridge.sessionChatRead.mockImplementation(async (_scope, input) => ok(page(input.sessionId, {
      items: input.sessionId === 2 ? [item('receipt', 'user', 'Compare', { mentions: [{ sessionId: 12, title: 'Other work' }] })] : [],
    })));
    reply.resolve(ok({ accepted: true })); await sending; await settle();
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
    expect(store.exchanges()).toEqual([]);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false); await settle();
    expect(store.exchanges()[0]?.mentions).toEqual([mention]);
    expect(store.exchanges()[0]?.prompt).toBe('Compare');
  });
  it('retains session context on navigation, sends stable identities and restores rejected context to its original draft', async () => {
    const { store, bridge } = setup(); await settle();
    store.state.update(value => value && ({ ...value, sessionMentions: true }));
    const mention = { id: '12', kind: 'session' as const, label: 'Same title' };
    store.addMention(mention); store.addMention(mention);
    store.setDraft('Review @Same title');
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
    expect(store.mentions()).toEqual([]);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false); await settle();
    store.state.update(value => value && ({ ...value, sessionMentions: true }));
    expect(store.mentions()).toEqual([mention]);
    const reply = deferred<BackendResult<{ accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(reply.promise);
    const sending = store.submit({ text: store.draft(), intent: 'send', context: [mention] });
    expect(store.mentions()).toEqual([]);
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith('scope', expect.objectContaining({ action: expect.objectContaining({ type: 'send', sessionIds: [12], text: 'Review @Same title' }) }));
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
    reply.resolve({ ok: false, error: { code: 'http', message: 'Session was removed' } }); await sending;
    expect(store.mentions()).toEqual([]);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false); await settle();
    expect(store.mentions()).toEqual([mention]);
    expect(store.draft()).toBe('Review @Same title');
    store.removeMention('12'); expect(store.mentions()).toEqual([]);
  });
  it("shows files-only prompts immediately and restores attachments to their original session after a rejected send", async () => {
    const { store, bridge } = setup();
    await settle();
    const drafts = TestBed.inject(SessionChatDrafts);
    const entry = drafts.entry('scope', 2);
    const file = { id: 'attachment', path: '/stored/notes.txt', name: 'notes.txt', kind: 'file' as const, status: 'ready' as const, file: new File(['notes'], 'notes.txt') };
    entry.files.set([file]);
    const write = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(write.promise);
    const sending = store.submit({ text: '', intent: 'send', context: [] });
    expect(store.exchanges().at(-1)?.attachments?.[0]?.name).toBe('notes.txt');
    expect(store.exchanges().at(-1)?.prompt).toBe('');
    expect(entry.files()).toEqual([]);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false);
    await settle();
    write.resolve({ ok: false, error: { code: 'http', status: 400, message: 'Rejected' } });
    await sending;
    expect(entry.files()).toEqual([file]);
    expect(drafts.entry('scope', 3).files()).toEqual([]);
  });

  it("cancels old reads and rejects late same-scope replies after session navigation", async () => {
    const { store, bridge } = setup();
    await settle();
    const old = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(80);
    store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, false);
    await settle();
    old.resolve(ok(page(2, { items: [item("old", "user", "Old session")] })));
    await settle();
    expect(store.items()).toEqual([]);
    expect(bridge.sessionChatCancel).toHaveBeenCalled();
    TestBed.resetTestingModule();
    const calls = bridge.sessionChatRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(calls);
  });
  it("shows sends immediately, keeps typing responsive, and restores rejected text without overwriting a new draft", async () => {
    const { store, bridge } = setup();
    await settle();
    const write = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(write.promise);
    store.setDraft("Original");
    const sendOrigin = { left: 20, top: 400, at: performance.now() };
    const sending = store.submit({
      text: "Original",
      sendOrigin,
      intent: "send",
      context: [],
    });
    expect(store.exchanges().at(-1)?.prompt).toBe("Original");
    expect(store.exchanges().at(-1)?.sendOrigin).toBe(sendOrigin);
    expect(JSON.stringify(bridge.sessionChatCommand.mock.calls)).not.toContain("sendOrigin");
    expect(store.draft()).toBe("");
    store.setDraft("Next thought");
    write.resolve({
      ok: false,
      error: { code: "http", status: 400, message: "Rejected" },
    });
    await sending;
    expect(store.draft()).toBe("Original\n\nNext thought");
    expect(store.exchanges()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("uses confirmed delivery when a command reply is lost (queue=%s)", async (queue) => {
    const { store, bridge } = setup();
    await settle();
    const write = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(write.promise);
    const sending = store.submit({ text: "Do the work", intent: queue ? "queue" : "send", context: [] });
    store.setDraft("Next thought");
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, queue
      ? { state: { ...state, queue: [{ id: "queued", text: "Do the work" }] } }
      : { items: [item("delivered", "user", "Do the work")] })));
    await store.refresh();
    write.resolve({ ok: false, error: { code: "outcome-unknown", message: "Check delivery" } });
    await sending;
    expect(store.uncertain()).toBe("");
    expect(store.error()).toBe("");
    expect(store.busy()).toBe("");
    expect(store.draft()).toBe("Next thought");
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps delivery uncertain when only running state and assistant output are observed", async () => {
    const { store, bridge } = setup();
    await settle();
    const write = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(write.promise);
    const sending = store.submit({ text: "Do the work", intent: "send", context: [] });
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      state: { ...state, phase: "running", canInterrupt: true },
      items: [item("output", "assistant", "Already working")],
    })));
    await store.refresh();
    write.resolve({ ok: false, error: { code: "outcome-unknown", message: "Check delivery" } });
    await sending;
    expect(store.uncertain()).toBe("Check delivery");
    expect(store.draft()).toBe("Do the work");
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  });

  it("blocks uncertain sends across navigation and never replays them on read recovery", async () => {
    const { store, bridge } = setup();
    await settle();
    bridge.sessionChatCommand.mockResolvedValueOnce({
      ok: false,
      error: { code: "outcome-unknown", message: "Check delivery" },
    });
    await store.submit({ text: "Do the work", intent: "send", context: [] });
    expect(store.uncertain()).toBe("Check delivery");
    expect(store.draft()).toBe("Do the work");
    store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, false);
    await settle();
    store.open({ scopeId: "scope", taskId: 1, sessionId: 2 }, false);
    await settle();
    expect(store.draft()).toBe("Do the work");
    expect(store.uncertain()).toBeTruthy();
    await store.refresh();
    await store.submit({ text: "Do the work", intent: "send", context: [] });
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
    store.acknowledgeUncertain();
    expect(store.uncertain()).toBe("");
  });
  it("rejects old backend scopes before dispatching a mutation", async () => {
    const { store, bridge, scope } = setup();
    await settle();
    scope.set({
      revision: 2,
      scope: { id: "other", environment: { kind: "local" } },
    });
    await store.submit({ text: "Wrong backend", intent: "send", context: [] });
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    expect(store.draft()).toBe("Wrong backend");
  });
  it("distinguishes queue from steering and removes optimistic prompts after authoritative delivery", async () => {
    const { store, bridge } = setup();
    await settle();
    await store.submit({ text: "Wait for me", intent: "queue", context: [] });
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", {
      taskId: 1,
      sessionId: 2,
      action: { type: "send", text: "Wait for me", queue: true },
    });
    await store.submit({
      text: "Change direction",
      intent: "steer",
      context: [],
    });
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", {
      taskId: 1,
      sessionId: 2,
      action: { type: "send", text: "Change direction", queue: false },
    });
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(page(2, { items: [item("server-id", "user", "Change direction")] })),
    );
    await store.refresh();
    expect(
      store
        .exchanges()
        .filter((exchange) => exchange.prompt === "Change direction"),
    ).toHaveLength(1);
  });
  it("replaces historical windows, pauses live reads, and retains drafts when returning to latest", async () => {
    const { store, bridge } = setup();
    await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(page(2, { before: "old", items: [item("latest", "user", "Latest")] })),
    );
    await store.refresh();
    store.setDraft("A draft");
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(page(2, { items: [item("earlier", "user", "Earlier")] })),
    );
    await store.older();
    expect(store.items()[0]?.id).toBe("earlier");
    const calls = bridge.sessionChatRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(calls);
    expect(store.draft()).toBe("A draft");
    await store.refresh();
    expect(store.historical()).toBe(false);
  });
  it("changes an unstarted harness without losing the draft or accepting an old provider reply", async () => {
    const { store, bridge } = setup();
    await settle();
    const available = {
      ...state,
      providerLocked: false,
      providers: [
        { id: "codex", label: "Codex" },
        { id: "claude", label: "Claude Code" },
      ],
    };
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(page(2, { state: available })),
    );
    await store.refresh();
    store.setDraft("Keep this draft");
    const oldRead = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockReturnValueOnce(oldRead.promise);
    await vi.advanceTimersByTimeAsync(80);
    const catalog = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockReturnValueOnce(catalog.promise);
    const changing = store.perform({
      type: "provider",
      provider: "claude",
      expectedProvider: "codex",
    });
    await settle();
    expect(store.state()).toBe(available);
    expect(store.busy()).toBe("provider");
    expect(store.loading()).toBe(true);
    await store.perform({ type: "model", model: "old-model" });
    await store.submit({
      text: "Keep this draft",
      intent: "send",
      context: [],
    });
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
    catalog.resolve(
      ok(
        page(2, {
          state: {
            ...available,
            provider: "claude",
            models: [{ id: "sonnet", label: "Sonnet" }],
          },
        }),
      ),
    );
    await changing;
    expect(store.busy()).toBe("");
    oldRead.resolve(ok(page()));
    await settle();
    expect(store.state()?.provider).toBe("claude");
    expect(store.state()?.models[0]?.id).toBe("sonnet");
    expect(store.draft()).toBe("Keep this draft");
    expect(bridge.sessionChatCancel).toHaveBeenCalled();
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", {
      taskId: 1,
      sessionId: 2,
      action: {
        type: "provider",
        provider: "claude",
        expectedProvider: "codex",
      },
    });
  });
  for (const navigate of [false, true]) {
    it(`does not restore old harness settings after ${navigate ? "navigation during reconciliation" : "a failed catalog read"}`, async () => {
      const { store, bridge } = setup();
      await settle();
      bridge.sessionChatRead.mockResolvedValueOnce(
        ok(
          page(2, {
            state: {
              ...state,
              providerLocked: false,
              providers: [{ id: "claude", label: "Claude Code" }],
            },
          }),
        ),
      );
      await store.refresh();
      const catalog = deferred<BackendResult<SessionChatPage>>();
      bridge.sessionChatRead.mockReturnValueOnce(catalog.promise);
      const changing = store.perform({
        type: "provider",
        provider: "claude",
        expectedProvider: "codex",
      });
      await settle();
      if (navigate) {
        store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, false);
        await settle();
      }
      catalog.resolve({
        ok: false,
        error: { code: "http", status: 503, message: "Unavailable" },
      });
      await changing;
      expect(store.busy()).toBe("");
      expect(store.state()).toEqual(navigate ? state : null);
      expect(store.error()).toBe(navigate ? "" : "Unavailable");
    });
  }
  it("does not dispatch a harness change on started sessions or engines without selection support", async () => {
    const { store, bridge } = setup();
    await settle();
    await store.perform({
      type: "provider",
      provider: "claude",
      expectedProvider: "codex",
    });
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(
        page(2, {
          state: {
            ...state,
            providerLocked: true,
            providers: [{ id: "claude", label: "Claude Code" }],
          },
        }),
      ),
    );
    await store.refresh();
    await store.perform({
      type: "provider",
      provider: "claude",
      expectedProvider: "codex",
    });
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });
  it("keeps early output under the pending prompt and settles previous cursors until its receipt arrives", async () => {
    const { store, bridge } = setup();
    await settle();
    const old = [
      item("u1", "user", "Hi"),
      item("a1", "assistant", "Hello"),
      item("s1", "system", "Turn completed"),
    ];
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: old })));
    await store.refresh();
    const sending = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(sending.promise);
    const operation = store.submit({
      text: "Write a file",
      intent: "send",
      context: [],
    });
    expect(store.empty()).toBe(false);
    expect(
      store.exchanges().filter((exchange) => exchange.status === "live"),
    ).toHaveLength(1);
    expect(store.exchanges().every((exchange) => !exchange.streaming)).toBe(
      true,
    );
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(
        page(2, {
          reset: false,
          state: { ...state, phase: "running" },
          events: [
            { type: "item", item: item("a2", "assistant", "Writing the file") },
          ],
        }),
      ),
    );
    await store.refresh();
    expect(
      store
        .exchanges()
        .map((exchange) => [
          exchange.prompt,
          exchange.answer,
          exchange.streaming,
        ]),
    ).toEqual([
      ["Hi", "Hello", false],
      ["Write a file", "Writing the file", true],
    ]);
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(
        page(2, {
          reset: false,
          state: { ...state, phase: "running" },
          events: [{ type: "item", item: item("u2", "user", "Write a file") }],
        }),
      ),
    );
    await store.refresh();
    expect(
      store.exchanges().map((exchange) => [exchange.prompt, exchange.answer]),
    ).toEqual([
      ["Hi", "Hello"],
      ["Write a file", "Writing the file"],
    ]);
    expect(
      store.exchanges().filter((exchange) => exchange.streaming),
    ).toHaveLength(1);
    sending.resolve(ok({ accepted: true }));
    await operation;
  });
  it("retains the current optimistic turn when a follow-up is queued before its user receipt", async () => {
    const { store, bridge } = setup();
    await settle();
    const old = [item("u1", "user", "Hi"), item("a1", "assistant", "Hello")];
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: old })));
    await store.refresh();
    bridge.sessionChatRead.mockResolvedValueOnce(
      ok(
        page(2, {
          items: [...old, item("a2", "assistant", "Working on it")],
          state: { ...state, phase: "running" },
        }),
      ),
    );
    await store.submit({ text: "Write a file", intent: "send", context: [] });
    await settle();
    const queued = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockReturnValueOnce(queued.promise);
    const operation = store.submit({
      text: "Also add a test",
      intent: "queue",
      context: [],
    });
    expect(store.queue().at(-1)?.text).toBe("Also add a test");
    expect(
      store.exchanges().map((exchange) => [exchange.prompt, exchange.answer]),
    ).toEqual([
      ["Hi", "Hello"],
      ["Write a file", "Working on it"],
    ]);
    expect(
      store.exchanges().filter((exchange) => exchange.streaming),
    ).toHaveLength(1);
    queued.resolve({
      ok: false,
      error: { code: "http", status: 400, message: "Queue rejected" },
    });
    await operation;
    expect(store.draft()).toBe("Also add a test");
    expect(store.exchanges().at(-1)?.prompt).toBe("Write a file");
  });
  it("keeps archived conversations read only and does not poll their runtime", async () => {
    const { store, bridge } = setup();
    await settle();
    store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, true);
    await settle();
    const calls = bridge.sessionChatRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    await store.perform({ type: "stop" });
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(calls);
  });
});
describe("provider-neutral transcript presentation", () => {
  it('pairs a result with the call identity when a provider omits its separate tool ID', () => {
    const [exchange] = chatExchanges([
      item('user', 'user', 'Check it'),
      item('call', 'tool_use', '', { toolKind: 'bash', input: '{"command":"pnpm test"}' }),
      item('result', 'tool_result', 'Tests passed', { toolId: 'call', truncated: true }),
    ], state, new Set());
    expect(exchange?.steps).toHaveLength(1);
    expect(exchange?.steps[0]).toMatchObject({ id: 'call', status: 'done', output: expect.stringContaining('Tests passed'), fullContent: { outputId: 'result' } });
  });
  it("preserves commentary order, tool input/output, explicit failures and final Markdown", () => {
    const exchanges = chatExchanges(
      [
        item("u", "user", "Fix it"),
        item("a", "assistant", "Checking"),
        item("t", "tool_use", "", {
          toolId: "call",
          toolKind: "mcp",
          toolName: "External tool",
          input: '{"query":"test"}',
        }),
        item("r", "tool_result", "Failed to connect", {
          toolId: "call",
          error: true,
        }),
        item("done", "assistant", "Here is the result."),
      ],
      state,
      new Set(),
    );
    expect(exchanges[0]?.steps.map((step) => step.id)).toEqual(["a", "t"]);
    expect(exchanges[0]?.steps[1]).toMatchObject({
      status: "failed",
      verb: "Failed to use connection",
      output: expect.stringContaining("Failed to connect"),
    });
    expect(exchanges[0]?.answer).toBe("Here is the result.");
    expect(exchanges[0]?.answerBeforeStepId).toBeUndefined();
  });
  it("keeps work on both sides of the latest message, including late paired results", () => {
    const items = [
      item("u", "user", "Check it"),
      item("before", "tool_use", "", { toolId: "first", toolKind: "read" }),
      item("a", "assistant", "Now checking tests"),
      item("late", "tool_result", "Read output", { toolId: "first" }),
      item("after", "tool_use", "", { toolId: "second", toolKind: "bash" }),
    ];
    const exchange = chatExchanges(items, { ...state, phase: "running" }, new Set())[0]!;
    expect(exchange.steps.map(step => step.id)).toEqual(["before", "after"]);
    expect(exchange.answerBeforeStepId).toBe("after");
    expect(exchange.steps[0]?.output).toContain("Read output");
    const completed = chatExchanges([...items, item("final", "assistant", "Done")], state, new Set())[0]!;
    expect(completed.steps.map(step => step.id)).toEqual(["before", "a", "after"]);
    expect(completed.answerBeforeStepId).toBeUndefined();
    expect(completed.answer).toBe("Done");
  });
  it("renders partial history and orphan results instead of silently discarding them", () => {
    const exchanges = chatExchanges(
      [item("orphan", "tool_result", "Tool output", { toolId: "missing" })],
      state,
      new Set(),
    );
    expect(exchanges[0]?.prompt).toBe("");
    expect(exchanges[0]?.steps[0]?.output).toBe("Tool output");
  });
  it("keeps the last reply visible when system records or tool receipts follow it", () => {
    for (const kind of [
      "system",
      "tool_result",
      "thinking",
      "error",
    ] as const) {
      const exchanges = chatExchanges(
        [
          item("u", "user", "Hi"),
          item("a", "assistant", "The final reply"),
          item("tail", kind, "Trailing record"),
        ],
        state,
        new Set(),
      );
      expect(exchanges[0]?.answer).toBe("The final reply");
      expect(exchanges[0]?.steps.some((step) => step.id === "a")).toBe(false);
      expect(exchanges[0]?.steps.some((step) => step.id === "tail")).toBe(true);
      expect(exchanges[0]?.streaming).toBe(false);
    }
  });
  it("does not put a reply cursor on completed commentary while a tool or question is active", () => {
    const items = [
      item("u", "user", "Work"),
      item("a", "assistant", "Checking"),
      item("t", "tool_use", "", { toolId: "call" }),
    ];
    expect(
      chatExchanges(items, { ...state, phase: "running" }, new Set())[0]
        ?.streaming,
    ).toBe(false);
    expect(
      chatExchanges(
        items.slice(0, 2),
        { ...state, phase: "waiting" },
        new Set(),
      )[0]?.streaming,
    ).toBe(false);
  });
});


it('keeps the visible chat lifetime and incremental cursor across same-machine recovery', async () => {
  const { store, bridge, scope } = setup(); await settle();
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [item('kept', 'user', 'Keep my reading position')] })));
  await store.refresh(); const view = store.viewRevision();
  TestBed.inject(SessionChatDrafts).rebind('scope', 'recovered');
  scope.set({ revision: 2, scope: { id: 'recovered', environment: { kind: 'local' } } });
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: false, items: [], events: [] })));
  store.open({ scopeId: 'recovered', taskId: 1, sessionId: 2 }, false); await settle();
  expect(store.viewRevision()).toBe(view); expect(store.items()[0]?.id).toBe('kept');
  expect(bridge.sessionChatRead).toHaveBeenLastCalledWith('recovered', expect.objectContaining({ after: 'cursor' }));
});
it('keeps an earlier-history window on screen instead of jumping to latest after recovery', async () => {
  const { store, bridge, scope } = setup(); await settle();
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: 'earlier', items: [item('latest', 'user', 'Latest')] }))); await store.refresh();
  bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [item('older', 'user', 'Reading history')] }))); await store.older();
  const calls = bridge.sessionChatRead.mock.calls.length, view = store.viewRevision();
  TestBed.inject(SessionChatDrafts).rebind('scope', 'recovered'); scope.set({ revision: 2, scope: { id: 'recovered', environment: { kind: 'local' } } });
  store.open({ scopeId: 'recovered', taskId: 1, sessionId: 2 }, false); await settle();
  expect(store.historical()).toBe(true); expect(store.items()[0]?.id).toBe('older'); expect(store.viewRevision()).toBe(view); expect(bridge.sessionChatRead).toHaveBeenCalledTimes(calls);
});
