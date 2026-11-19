import { parseBrowserElements } from '@elevenex/shared';
import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendResult,
  BackendClientState,
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
import { SessionChatLoadingPolicy, SESSION_CHAT_PROGRESSIVE_LOADING } from './session-chat-loading';
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
function setup(options: { initial?: Promise<BackendResult<SessionChatPage>>; progressive?: boolean } = {}) {
  const scope = signal<BackendClientState>({
    revision: 1,
    scope: { id: "scope", environment: { kind: "local" as const } },
  });
  const bridge = {
    sessionChatRead: vi.fn(async (_scope, input) => ok(page(input.sessionId))),
    sessionChatCommand: vi.fn<NonNullable<ElevenexBridge["sessionChatCommand"]>>(async () => ok({ accepted: true as const })),
    sessionChatCancel: vi.fn(async () => undefined),
  } satisfies Pick<
    ElevenexBridge,
    "sessionChatRead" | "sessionChatCommand" | "sessionChatCancel"
  >;
  if (options.initial) bridge.sessionChatRead.mockImplementationOnce(() => options.initial!);
  TestBed.configureTestingModule({
    providers: [
      SessionChatStore,
      SessionChatDrafts,
      { provide: SESSION_CHAT_PROGRESSIVE_LOADING, useValue: options.progressive ?? false },
      { provide: ELEVENEX_BRIDGE, useValue: bridge },
      { provide: BackendClientService, useValue: { state: scope } },
    ],
  });
  const store = TestBed.inject(SessionChatStore);
  store.open({ scopeId: "scope", taskId: 1, sessionId: 2 }, false);
  return { store, bridge, scope };
}

it('coalesces seen writes and rejects late acknowledgments across completions and selection changes', async () => {
  const { store, bridge } = setup(); await settle();
  const first = '2026-11-14T12:00:00.000Z', next = '2026-11-14T12:01:00.000Z';
  store.state.set({ ...state, unseenCompletionAt: first });
  const pending = deferred<BackendResult<{ readonly accepted: true }>>();
  bridge.sessionChatCommand.mockImplementationOnce(() => pending.promise);
  const seen = store.markSeen(); await store.markSeen();
  expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  store.state.set({ ...state, unseenCompletionAt: next });
  pending.resolve(ok({ accepted: true })); await seen;
  expect(store.state()?.unseenCompletionAt).toBe(next);
  store.historical.set(true); await store.markSeen();
  expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  store.historical.set(false); store.setActive(false); await store.markSeen();
  expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
  store.setActive(true);
  const old = deferred<BackendResult<{ readonly accepted: true }>>();
  bridge.sessionChatCommand.mockImplementationOnce(() => old.promise);
  const late = store.markSeen();
  store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
  store.state.set({ ...state, unseenCompletionAt: next });
  old.resolve(ok({ accepted: true })); await late;
  expect(store.state()?.unseenCompletionAt).toBe(next);
});

it('retains unseen state after a failed acknowledgment and supports older engines without the field', async () => {
  const { store, bridge } = setup(); await settle();
  await store.markSeen(); expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  const at = '2026-11-14T12:00:00.000Z'; store.state.set({ ...state, unseenCompletionAt: at });
  bridge.sessionChatCommand.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Offline' } });
  await store.markSeen(); expect(store.state()?.unseenCompletionAt).toBe(at);
  await store.markSeen(); expect(store.state()?.unseenCompletionAt).toBeNull();
});

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
  it('opens a bounded window by default and does not interpret long polls as a slow connection', async () => {
    const { store, bridge } = setup(); await settle();
    expect(bridge.sessionChatRead.mock.calls[0]?.[1].loadingMode).toBe('window');
    const poll = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockImplementationOnce(() => poll.promise);
    await vi.advanceTimersByTimeAsync(9000);
    expect(store.progressiveLoading()).toBe(false);
    expect(bridge.sessionChatCancel).not.toHaveBeenCalled();
  });

  it('switches the app to progressive pages after a slow opening and rejects the cancelled window', async () => {
    const first = deferred<BackendResult<SessionChatPage>>();
    const second = deferred<BackendResult<SessionChatPage>>();
    const { store, bridge, scope } = setup({ initial: first.promise });
    bridge.sessionChatRead.mockImplementationOnce(() => second.promise);
    await vi.advanceTimersByTimeAsync(2999);
    expect(store.progressiveLoading()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.progressiveLoading()).toBe(true);
    expect(store.loading()).toBe(true);
    expect(bridge.sessionChatCancel).toHaveBeenCalledWith('scope', bridge.sessionChatRead.mock.calls[0]![1].requestId);
    expect(bridge.sessionChatRead.mock.calls[1]?.[1].loadingMode).toBe('progressive');
    first.resolve(ok(page(2, { items: [item('stale', 'assistant', 'Old larger response')] })));
    await settle(); expect(store.state()).toBeNull();
    second.resolve(ok(page(2, { items: [item('latest', 'assistant', 'Latest reply')] })));
    await settle(); expect(store.items().at(-1)?.id).toBe('latest');
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false);
    await settle(); expect(store.progressiveLoading()).toBe(true);
    expect(bridge.sessionChatRead.mock.calls.at(-1)?.[1].loadingMode).toBe('progressive');
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false);
    expect(store.progressiveLoading()).toBe(true);
    expect(bridge.sessionChatRead.mock.calls.at(-1)?.[1].loadingMode).toBe('progressive');
    TestBed.inject(SessionChatDrafts).rebind('scope', 'reconnected');
    scope.set({ revision: 2, scope: { id: 'reconnected', environment: { kind: 'local' } } });
    store.open({ scopeId: 'reconnected', taskId: 1, sessionId: 2 }, false);
    expect(store.progressiveLoading()).toBe(false);
    expect(bridge.sessionChatRead.mock.calls.at(-1)?.[1].loadingMode).toBe('window');
  });

  it('shares the fallback with other chat owners and replaces their pending initial windows', async () => {
    const first = deferred<BackendResult<SessionChatPage>>();
    const second = deferred<BackendResult<SessionChatPage>>();
    const { store, bridge } = setup({ initial: first.promise });
    bridge.sessionChatRead.mockImplementationOnce(() => second.promise);
    const other = TestBed.runInInjectionContext(() => new SessionChatStore());
    other.open({ scopeId: 'scope', taskId: 2, sessionId: 3 }, false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.progressiveLoading()).toBe(true);
    expect(other.progressiveLoading()).toBe(true);
    expect(bridge.sessionChatRead.mock.calls.filter(([, read]) => read.sessionId === 3).map(([, read]) => read.loadingMode))
      .toEqual(['window', 'progressive']);
    expect(bridge.sessionChatCancel).toHaveBeenCalledTimes(2);
    first.resolve(ok(page(2, { items: [item('stale-2', 'assistant', 'Old window')] })));
    second.resolve(ok(page(3, { items: [item('stale-3', 'assistant', 'Old window')] })));
    await settle();
    expect(store.items()).toEqual([]);
    expect(other.items()).toEqual([]);
    const next = TestBed.runInInjectionContext(() => new SessionChatStore());
    next.open({ scopeId: 'scope', taskId: 3, sessionId: 4 }, false);
    expect(next.progressiveLoading()).toBe(true);
    expect(bridge.sessionChatRead.mock.calls.at(-1)?.[1].loadingMode).toBe('progressive');
  });

  it('clears the opening deadline on success, navigation, hiding and destruction', async () => {
    const first = deferred<BackendResult<SessionChatPage>>();
    const { store, bridge } = setup({ initial: first.promise });
    await vi.advanceTimersByTimeAsync(2999);
    first.resolve(ok(page())); await settle();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.progressiveLoading()).toBe(false);
    const next = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockImplementationOnce(() => next.promise);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false);
    await vi.advanceTimersByTimeAsync(1000);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 4 }, false);
    await settle(); await vi.advanceTimersByTimeAsync(2000);
    expect(store.progressiveLoading()).toBe(false);
    bridge.sessionChatRead.mockImplementationOnce(() => next.promise);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 5 }, false);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.progressiveLoading()).toBe(false);
    TestBed.resetTestingModule();
    const calls = bridge.sessionChatRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(calls);
  });

  it('allows the rollout flag to opt in immediately', async () => {
    const { store, bridge } = setup({ progressive: true }); await settle();
    expect(store.progressiveLoading()).toBe(true);
    expect(bridge.sessionChatRead.mock.calls[0]?.[1].loadingMode).toBe('progressive');
  });

  it('does not let a stale connection enable fallback on the reconnected app', async () => {
    const { store, scope } = setup(); await settle();
    const policy = TestBed.inject(SessionChatLoadingPolicy);
    scope.set({ revision: 2, scope: null });
    expect(policy.enableProgressive('scope')).toBe(false);
    scope.set({ revision: 3, scope: { id: 'new-scope', environment: { kind: 'local' } } });
    expect(policy.enableProgressive('scope')).toBe(false);
    expect(store.progressiveLoading()).toBe(false);
  });
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
    const mounted = store.exchanges();
    store.state.set({ ...store.state()!, activity: [{ id: 'background', label: 'Working', detail: 'Other activity' }] });
    expect(store.exchanges()).toBe(mounted);
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
  it('retains element identity and image association through uncertain queue delivery without replaying', async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { state: { ...state, browserElements: true, attachments: true } }))); await store.refresh();
    const drafts = TestBed.inject(SessionChatDrafts), entry = drafts.entry('scope', 2);
    const reference = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', tag: 'button', selector: 'button', frames: [], page: 'https://example.com/checkout', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: { x: 20, y: 30, width: 80, height: 30 }, crop: { x: 0, y: 0, width: 148, height: 108 }, image: { width: 148, height: 108, scale: 1 } };
    const file = { id: 'image-1', name: 'element.jpg', path: '/stored/element.jpg', kind: 'image' as const, status: 'ready' as const, element: reference, marker: 1, file: new File(['image'], 'element.jpg') };
    entry.files.set([file]);
    const before = bridge.sessionChatCommand.mock.calls.length;
    await store.submit({ text: 'Align ❶ with ❷', intent: 'queue', context: [] });
    expect(store.error()).toContain('❷ doesn’t match an element');
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(before);
    bridge.sessionChatCommand.mockResolvedValueOnce({ ok: false, error: { code: 'outcome-unknown', message: 'Check delivery' } });
    await store.submit({ text: 'Align ❶', intent: 'queue', context: [] });
    const action = bridge.sessionChatCommand.mock.calls.at(-1)?.[1].action;
    if (action?.type !== 'send') throw new Error('Missing send');
    expect(action.text.startsWith('Align ❶\n\n<elevenex_browser_elements_v1>')).toBe(true);
    expect(action.text).toContain('"marker":"❶"');
    expect(parseBrowserElements(action.text).elements[0]).toMatchObject({ marker: 1, attachment: 'element.jpg', imageIndex: 1, reference: { id: reference.id } });
    expect(entry.files()[0]?.element?.id).toBe(reference.id);
    expect(store.uncertain()).toBe('Check delivery');
    const writes = bridge.sessionChatCommand.mock.calls.length;
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
    expect(drafts.entry('scope', 3).files()).toHaveLength(0);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false); await settle();
    expect(store.uncertain()).toBeTruthy(); expect(entry.files()[0]?.element).toEqual(reference);
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(writes);
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
  it("stitches older pages into the chat without pausing live state or losing the draft", async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: "latest", next: null, items: [item("latest", "user", "Latest")] })));
    await store.refresh(); store.setDraft("A draft");
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { next: "earlier", items: [item("earlier", "user", "Earlier")] })));
    await store.older();
    expect(store.items().map(item => item.id)).toEqual(["earlier", "latest"]);
    const calls = bridge.sessionChatRead.mock.calls.length;
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: false, next: null, state: { ...state, phase: "running" } })));
    await vi.advanceTimersByTimeAsync(80);
    expect(bridge.sessionChatRead.mock.calls.length).toBeGreaterThan(calls);
    expect(store.state()?.phase).toBe("running"); expect(store.draft()).toBe("A draft");
  });
  it('keeps leading context before an optimistic prompt while its command is pending', async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { leadingPrompt: item('old-user', 'user', 'Earlier request'),
      items: [item('old-answer', 'assistant', 'Earlier answer')] })));
    await store.refresh();
    const command = deferred<BackendResult<{ readonly accepted: true }>>();
    bridge.sessionChatCommand.mockImplementationOnce(() => command.promise);
    const submission = store.submit({ text: 'Next request', intent: 'send', context: [] });
    await settle();
    expect(store.exchanges().map(exchange => exchange.prompt)).toEqual(['Earlier request', 'Next request']);
    expect(store.exchanges()[0]?.answer).toBe('Earlier answer');
    command.resolve(ok({ accepted: true })); await submission;
  });

  it('retains a distant prompt through paging, eviction, cached reopening and live growth', async () => {
    const { store, bridge } = setup(); await settle();
    const prompt = item('prompt-context', 'user', 'Keep this prompt above the reply');
    const history = Array.from({ length: 800 }, (_, i) => item(String(i), 'assistant', `Message ${i}`));
    bridge.sessionChatRead.mockImplementation(async (_scope, input) => {
      const from = input.following ? Number(input.following) + 1 : Math.max(0, Number(input.before ?? history.length) - 80);
      const end = Math.min(history.length, from + 80);
      return ok(page(2, { leadingPrompt: prompt, items: history.slice(from, end), before: from ? String(from) : null, next: end < history.length ? String(end - 1) : null }));
    });
    await store.refresh();
    const assertContext = () => {
      expect(store.items().some(item => item.id === prompt.id)).toBe(false);
      expect(store.exchanges()[0]?.id).toBe(prompt.id);
      expect(store.exchanges()[0]?.prompt).toBe(prompt.text);
      expect(store.exchanges()[0]?.isNew).toBe(false);
      expect(store.items().length).toBeLessThanOrEqual(320);
    };
    assertContext();
    for (let i = 0; i < 6; i++) { await store.older(); assertContext(); }
    while (store.next()) { await store.newer(); assertContext(); }
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false);
    assertContext(); await settle(); assertContext();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: false, events: [
      { type: 'item', item: item('800', 'assistant', 'Live continuation') },
    ] })));
    await vi.advanceTimersByTimeAsync(80); assertContext();
    expect(store.items().at(-1)?.id).toBe('800');
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [prompt, ...history.slice(0, 79)] })));
    await store.refresh();
    expect(store.leadingPrompt()).toBeNull();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: false,
      events: history.slice(79, 399).map(item => ({ type: 'item', item })),
    })));
    await vi.advanceTimersByTimeAsync(80); assertContext();
    expect(store.leadingPrompt()?.id).toBe(prompt.id);

  });

  it('reconciles Claude thought and answer blocks with split saved history after streaming', async () => {
    const { store, bridge } = setup();
    await settle();
    const prompt = item('prompt', 'user', 'What changed?');
    const thought = item('msg_response:0', 'thinking', 'Check the result.');
    const answer = item('msg_response:1', 'assistant', 'The change is ready');
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      items: [prompt, thought, answer],
      state: { ...state, provider: 'claude', phase: 'running' },
    })));
    await store.refresh();
    expect(store.exchanges()[0]?.answerId).toBe(answer.id);

    const savedAnswer = { ...answer, id: 'msg_response:assistant:0', text: 'The change is ready.' };
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      items: [prompt, { ...thought, id: 'msg_response:thinking:0' }, savedAnswer],
      state: { ...state, provider: 'claude' },
    })));
    await vi.advanceTimersByTimeAsync(80);
    const [exchange] = store.exchanges();
    expect(exchange?.status).toBe('done');
    expect(exchange?.answer).toBe(savedAnswer.text);
    expect(exchange?.answerId).toBe(answer.id);
    expect(exchange?.steps.map(step => [step.id, step.kind, step.text])).toEqual([
      [thought.id, 'think', thought.text],
    ]);
  });

  it('retains a reconciled turn identity when only its compact context remains visible', async () => {
    const { store, bridge } = setup(); await settle();
    await store.submit({ text: 'Hi', intent: 'send', context: [] });
    const temporaryId = store.exchanges().at(-1)!.id;
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: 'receipt', items: [
      item('receipt', 'user', 'Hi'),
      ...Array.from({ length: 318 }, (_, i) => item(`work-${i}`, 'system', 'Work')),
      item('answer', 'assistant', 'Done'),
    ] })));
    await store.refresh();
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: `older-${pageIndex}`, items:
        Array.from({ length: 80 }, (_, i) => item(`older-${pageIndex}-${i}`, 'system', 'Earlier work')),
      })));
      await store.older();
    }
    expect(store.items().some(item => item.id === 'receipt')).toBe(false);
    expect(store.exchanges().at(-1)?.renderId).toBe(temporaryId);
    expect(store.exchanges().at(-1)?.answer).toBe('Done');
  });

  it('keeps collapsed replies, media and outcomes while hidden work leaves the raw window', async () => {
    const { store, bridge } = setup(); await settle();
    const first = item('prompt', 'user', 'Original request');
    const answer = item('final', 'assistant', 'The finished answer');
    const media = item('image', 'tool_result', '', { media: [{ id: 'image', path: '/capture.png', caption: 'Capture', inline: true }] });
    const outcome = item('outcome', 'system', '', { changes: { total: 1, files: [{ path: 'fix.ts', status: 'M', add: 2, del: 1 }] } });
    const history = [first, ...Array.from({ length: 1000 }, (_, i) => item(String(i), i % 30 ? 'system' : 'assistant', `Progress ${i}`)), media, answer, outcome];
    bridge.sessionChatRead.mockImplementation(async (_scope, input) => {
      const from = input.following ? history.findIndex(item => item.id === input.following) + 1
        : Math.max(0, (input.before ? history.findIndex(item => item.id === input.before) : history.length) - 80);
      const end = Math.min(history.length, from + 80);
      return ok(page(2, { leadingPrompt: from ? first : null, items: history.slice(from, end),
        before: from ? history[from]!.id : null, next: end < history.length ? history[end - 1]!.id : null }));
    });
    await store.refresh();
    const original = store.exchanges()[0]!;
    for (let i = 0; i < 11; i++) {
      await store.older();
      const exchange = store.exchanges()[0]!;
      expect(exchange.answerId).toBe('final');
      expect(exchange.answer).toBe(original.answer);
      expect(exchange.files).toEqual(original.files);
      expect(store.items().length).toBeLessThanOrEqual(320);
    }
    while (store.next()) {
      await store.newer();
      expect(store.exchanges()[0]?.answer).toBe(original.answer);
      expect(store.items().length).toBeLessThanOrEqual(320);
    }
    // Context belongs to this reading window, never an explicit replacement or
    // another session, and cannot duplicate replies when raw pages catch up.
    expect(store.exchanges()[0]?.answer?.match(/finished answer/g)).toHaveLength(1);
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [first, item('replacement', 'assistant', 'Replaced history')] })));
    await store.refresh();
    expect(store.exchanges()[0]?.answer).toBe('Replaced history');
  });

  it("scrolls both directions across thousands of items with a bounded contiguous window", async () => {
    const { store, bridge } = setup(); await settle();
    const history = Array.from({ length: 4000 }, (_, i) => item(String(i), i % 2 ? "assistant" : "user", `Message ${i}`));
    bridge.sessionChatRead.mockImplementation(async (_scope, input) => {
      const from = input.following ? Number(input.following) + 1 : Math.max(0, Number(input.before ?? history.length) - 80);
      const end = Math.min(history.length, from + 80);
      return ok(page(2, { items: history.slice(from, end), before: from ? String(from) : null, next: end < history.length ? String(end - 1) : null }));
    });
    await store.refresh();
    for (let i = 0; i < 40; i++) {
      await store.older();
      expect(store.items().length).toBeLessThanOrEqual(320);
      expect(store.items().every((item, i, items) => !i || Number(item.id) === Number(items[i - 1]!.id) + 1)).toBe(true);
    }
    expect(store.historical()).toBe(true);
    const pinned = store.items();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { reset: true, items: history.slice(-80), next: null, state: { ...state, phase: "running" } })));
    await vi.advanceTimersByTimeAsync(80);
    expect(store.items()).toBe(pinned); expect(store.state()?.phase).toBe("running");
    while (store.next()) { await store.newer(); expect(store.items().length).toBeLessThanOrEqual(320); }
    expect(store.items().at(-1)?.id).toBe("3999"); expect(store.historical()).toBe(false);
  });
  it('does not flash a paged historical window before loading the latest session', async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: 'latest', next: null,
      items: Array.from({ length: 320 }, (_, index) => item(String(index), 'user', `Message ${index}`)) })));
    await store.refresh();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { next: 'earlier', items: [item('earlier', 'user', 'Earlier')] })));
    await store.older();
    expect(store.historical()).toBe(true);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 3 }, false); await settle();
    bridge.sessionChatRead.mockReturnValueOnce(deferred<BackendResult<SessionChatPage>>().promise);
    store.open({ scopeId: 'scope', taskId: 1, sessionId: 2 }, false);
    expect(store.loading()).toBe(true);
    expect(store.state()).toBeNull();
    expect(store.items()).toEqual([]);
  });
  it("reconciles the live tail before sending from history and never dispatches a duplicate send", async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: "320", next: null, items: Array.from({ length: 320 }, (_, i) => item(String(i + 320), "user", `Message ${i}`)) })));
    await store.refresh();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [item("earlier", "user", "Earlier")], next: "earlier" })));
    await store.older(); expect(store.historical()).toBe(true);
    store.setDraft("Reply from history");
    const read = deferred<BackendResult<SessionChatPage>>(); bridge.sessionChatRead.mockReturnValueOnce(read.promise);
    const sending = store.submit({ text: store.draft(), intent: "send", context: [] });
    await store.submit({ text: store.draft(), intent: "send", context: [] });
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    read.resolve(ok(page(2, { next: null, items: [item("latest", "user", "Current live tail")] })));
    await sending; expect(bridge.sessionChatCommand).toHaveBeenCalledOnce();
  });
  it("keeps a failed history read retryable and rejects a history reply after navigation", async () => {
    const { store, bridge } = setup(); await settle();
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { before: "latest", next: null, items: [item("latest", "user", "Latest")] })));
    await store.refresh();
    bridge.sessionChatRead.mockResolvedValueOnce({ ok: false, error: { code: "transport", message: "Try again" } });
    await store.older(); expect(store.historyError()).toBe("Try again"); expect(store.items()[0]?.id).toBe("latest");
    const pending = deferred<BackendResult<SessionChatPage>>();
    bridge.sessionChatRead.mockReturnValueOnce(pending.promise);
    const read = store.older(); store.open({ scopeId: "scope", taskId: 1, sessionId: 3 }, false);
    pending.resolve(ok(page(2, { items: [item("old", "user", "Old session")] }))); await read; await settle();
    expect(store.items().some(item => item.id === "old")).toBe(false); expect(store.historyLoading()).toBe(false);
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
  it.each(['automatic', 'steer'] as const)('shows a dequeued prompt and its answer on %s dispatch without a local send', async dispatch => {
    const { store, bridge } = setup();
    await settle();
    const initial = [item('u1', 'user', 'Initial prompt'), item('a1', 'assistant', 'Initial answer')];
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      items: initial,
      state: { ...state, phase: 'running', queue: [{ id: 'q1', text: 'Same follow-up' }, { id: 'q2', text: 'Same follow-up' }] },
    })));
    await store.refresh();
    const receipt = item('native-user', 'user', 'Same follow-up');
    const answer = item('a2', 'assistant', 'New answer');
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, {
      reset: false,
      events: [{ type: 'item', item: receipt }, { type: 'item', item: answer }],
      state: { ...state, phase: 'running', queue: [{ id: 'q2', text: 'Same follow-up' }] },
    })));
    if (dispatch === 'steer') await store.perform({ type: 'steer-queued', id: 'q1' });
    else await vi.advanceTimersByTimeAsync(80);
    await settle();
    expect(store.exchanges().map(exchange => [exchange.id, exchange.prompt, exchange.answer])).toEqual([
      ['u1', 'Initial prompt', 'Initial answer'], ['native-user', 'Same follow-up', 'New answer'],
    ]);
    expect(store.queue().map(item => item.id)).toEqual(['q2']);
    bridge.sessionChatRead.mockResolvedValueOnce(ok(page(2, { items: [...initial, receipt, answer] })));
    await store.refresh();
    expect(store.exchanges().filter(exchange => exchange.prompt === 'Same follow-up')).toHaveLength(1);
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(dispatch === 'steer' ? 1 : 0);
  });
});
describe("provider-neutral transcript presentation", () => {
  it('keeps distinct Claude blocks and repeated replies while pairing streamed and saved copies', () => {
    const previous = item('msg_progress:0', 'assistant', 'Ready.');
    const thought = item('msg_final:0', 'thinking', 'Check both results.');
    const first = item('msg_final:1', 'assistant', 'Ready.');
    const second = item('msg_final:2', 'assistant', 'Both results match.');
    const [exchange, later] = chatExchanges([
      item('u1', 'user', 'Check both results'), previous, thought, first, second,
      item('u2', 'user', 'Check again'), item('msg_next:0', 'assistant', 'Ready.'),
      { ...previous, id: 'msg_progress:assistant:0' },
      { ...thought, id: 'msg_final:thinking:0' },
      { ...first, id: 'msg_final:assistant:0' },
      { ...second, id: 'msg_final:assistant:1' },
    ], state, new Set());
    expect(exchange?.steps.map(step => [step.id, step.text])).toEqual([
      [previous.id, 'Ready.'], [thought.id, thought.text],
    ]);
    expect(exchange?.answerId).toBe(first.id);
    expect(exchange?.answer).toBe('Ready.\n\nBoth results match.');
    expect(later?.answer).toBe('Ready.');
  });

  it('keeps successful generated media visible beside the final answer and deduplicates assistant embeds', () => {
    const media = [{ id: 'image', path: '/generated.png', caption: 'Result', inline: true }];
    const output = item('image-output', 'tool_result', 'Image attachment', { toolId: 'draw', media });
    const input = item('draw', 'tool_use', '', { toolId: 'draw', toolName: 'imagegen' });
    const prompt = item('prompt', 'user', 'Draw it');
    const [exchange] = chatExchanges([prompt, input, output, item('again', 'tool_result', 'Same image', { media }), item('final', 'assistant', 'Done')], state, new Set());
    expect(exchange?.answer).toBe('Done\n\n![Result](/generated.png)');
    expect(exchange?.steps.some(step => step.id === 'draw')).toBe(true);
    const [embedded] = chatExchanges([prompt, input, output, item('final', 'assistant', 'Done\n\n![Preview](</generated.png>)')], state, new Set());
    expect(embedded?.answer).toBe('Done\n\n![Preview](</generated.png>)');
    const [failed] = chatExchanges([prompt, input, { ...output, error: true }, item('final', 'assistant', 'Could not draw it')], state, new Set());
    expect(failed?.answer).toBe('Could not draw it');
  });

  it("keeps inline images with their source commentary instead of appending them to the answer", () => {
    const [exchange] = chatExchanges([
      item("u", "user", "Check it"),
      item("image", "assistant", "First capture", { media: [
        { id: "image-1", path: "/tmp/capture.png", caption: "Capture", inline: true },
      ] }),
      item("tool", "tool_use", "", { toolId: "check", toolName: "bash" }),
      item("final", "assistant", "Done"),
    ], null, new Set());
    expect(exchange?.answer).toBe("Done");
    expect(exchange?.steps.find(step => step.id === "image")?.text)
      .toBe("First capture\n\n![Capture](/tmp/capture.png)");
  });

  it("measures settled turns from the prompt to their last activity and lets live turns count", () => {
    const at = (time: string) => ({ timestamp: `2026-10-28T12:${time}Z` });
    const items = [
      item("u1", "user", "Fix it", at("00:00")),
      item("a1", "assistant", "Done", at("02:14")),
      item("u2", "user", "Again", at("03:00")),
      item("t2", "tool_use", "", { ...at("03:05"), toolKind: "bash" }),
    ];
    const [settled, live] = chatExchanges(items, { ...state, phase: "running" }, new Set());
    expect(settled).toMatchObject({ status: "done", duration: 134 });
    expect(live).toMatchObject({ status: "live", duration: undefined, startedAt: Date.parse("2026-10-28T12:03:00Z") });
    const [partial] = chatExchanges([item("a0", "assistant", "Earlier", at("01:00"))], state, new Set());
    expect(partial?.duration).toBeUndefined();
  });
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
  expect(store.items()[0]?.id).toBe('older'); expect(store.viewRevision()).toBe(view); expect(bridge.sessionChatRead.mock.calls.length).toBeGreaterThan(calls);
});
