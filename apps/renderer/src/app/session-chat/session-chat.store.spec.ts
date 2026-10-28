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
import { SessionChatDrafts } from "./session-chat-drafts";
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
    const sending = store.submit({
      text: "Original",
      intent: "send",
      context: [],
    });
    expect(store.exchanges().at(-1)?.prompt).toBe("Original");
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
      verb: "External tool",
      output: expect.stringContaining("Failed to connect"),
    });
    expect(exchanges[0]?.answer).toBe("Here is the result.");
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
});
