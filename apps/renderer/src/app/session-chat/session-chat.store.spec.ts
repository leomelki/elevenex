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
