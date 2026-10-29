import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendResult,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "../backend/backend-client.service";
import { SessionChatDrafts } from "./session-chat-drafts";
import { SessionChatComponent } from "./session-chat.component";
import { MarkdownComponent, NowLineComponent } from "../conversation";

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
});

beforeEach(() => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function settle<T>(fixture: ComponentFixture<T>): Promise<void> {
  for (let pass = 0; pass < 15; pass++) {
    await Promise.resolve();
    fixture.detectChanges();
  }
  await fixture.whenStable();
}

function setup(items: readonly SessionChatItem[] = [], chatState = state) {
  let page: SessionChatPage = {
    taskId: 1,
    sessionId: 2,
    cursor: "cursor",
    reset: true,
    before: null,
    items,
    events: [],
    state: chatState,
  };
  let resolve!: (value: BackendResult<{ readonly accepted: true }>) => void;
  const bridge = {
    sessionChatRead: vi.fn(async () => ({ ok: true as const, value: page })),
    sessionChatCommand: vi.fn(
      () =>
        new Promise<BackendResult<{ readonly accepted: true }>>((yes) => {
          resolve = yes;
        }),
    ),
    sessionChatCancel: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      SessionChatDrafts,
      { provide: ELEVENEX_BRIDGE, useValue: bridge },
      {
        provide: BackendClientService,
        useValue: {
          state: signal({
            revision: 1,
            scope: { id: "scope", environment: { kind: "local" } },
          }),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(SessionChatComponent);
  fixture.componentRef.setInput("selection", {
    scopeId: "scope",
    taskId: 1,
    sessionId: 2,
  });
  fixture.detectChanges();
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    bridge,
    publish: (next: SessionChatPage) => {
      page = next;
    },
    complete: () => resolve({ ok: true, value: { accepted: true } }),
  };
}

describe("connected chat reply rendering", () => {
  for (const phase of ["running", "idle"] as const) {
    it(`keeps tools after the message that introduced them while ${phase}, with collapsible output`, async () => {
      const { fixture, root } = setup([
        item("u", "user", "Check the code"),
        item("a", "assistant", "I’ll check the code first."),
        { ...item("t", "tool_use", ""), toolId: "call", toolKind: "bash", toolName: "Run command", input: '{"command":"pnpm test"}' },
        { ...item("r", "tool_result", "All tests passed"), toolId: "call" },
      ], { ...state, phase });
      await settle(fixture);
      const turn = root.querySelector<HTMLElement>("ex-turn")!;
      const toggle = turn.querySelector<HTMLButtonElement>(".work")!;
      if (toggle.getAttribute("aria-expanded") === "false") toggle.click();
      await settle(fixture);
      const answer = turn.querySelector(".answer")!;
      const tool = turn.querySelector("ex-tool-step")!;
      expect(answer.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(turn.querySelector(".facts")?.textContent).toContain("Ran 1 command");
      expect(turn.querySelectorAll(".caret")).toHaveLength(0);
      const head = tool.querySelector<HTMLButtonElement>(".head")!;
      expect(head.getAttribute("aria-expanded")).toBe("false");
      head.click();
      await settle(fixture);
      expect(head.getAttribute("aria-expanded")).toBe("true");
      expect(tool.querySelector("pre")?.textContent).toContain("All tests passed");
      toggle.click();
      await settle(fixture);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(tool.closest("ex-fold[inert]")).not.toBeNull();
      expect(answer.closest("[inert]")).toBeNull();
    });
  }
  it("shows final text outside collapsed work even when a system record follows it", async () => {
    const { fixture, root } = setup([
      item("u", "user", "Hi"),
      item("a", "assistant", "Here is the final reply."),
      item("s", "system", "Completed"),
    ]);
    await settle(fixture);
    fixture.detectChanges();
    expect(
      root.querySelector("ex-turn .work")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(root.querySelector("ex-turn .answer")?.textContent).toContain(
      "Here is the final reply.",
    );
    expect(root.querySelector("ex-turn .answer .caret")).toBeNull();
  });
  it("hides the empty prompt immediately on submit and keeps early text in the new turn only", async () => {
    const { fixture, root, publish, complete } = setup();
    await settle(fixture);
    fixture.detectChanges();
    expect(root.querySelector(".start")).not.toBeNull();
    const sending = fixture.componentInstance.store.submit({
      text: "First question",
      intent: "send",
      context: [],
    });
    fixture.detectChanges();
    expect(root.querySelector(".start")).toBeNull();
    expect(root.querySelector("ex-skeleton")).toBeNull();
    publish({
      taskId: 1,
      sessionId: 2,
      cursor: "next",
      reset: false,
      before: null,
      items: [],
      events: [{ type: "item", item: item("a1", "assistant", "First answer") }],
      state: { ...state, phase: "running" },
    });
    await fixture.componentInstance.store.refresh();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(root.querySelector(".start")).toBeNull();
    expect(root.querySelectorAll("ex-turn .answer .caret")).toHaveLength(1);
    expect(root.querySelector("ex-turn .answer")?.textContent).toContain(
      "First answer",
    );
    complete();
    await sending;
  });
});

describe("streaming cursor ownership", () => {
  it("can retain the last thinking line without retaining its cursor", async () => {
    const fixture = TestBed.createComponent(NowLineComponent);
    fixture.componentRef.setInput("step", {
      id: "thinking",
      kind: "think",
      text: "Considering the change",
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll(".caret"),
    ).toHaveLength(1);
    fixture.componentRef.setInput("streaming", false);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll(".caret"),
    ).toHaveLength(0);
  });
  for (const source of [
    "Writing text",
    "```ts\nconst value = 1;",
    "> ```ts\n> const value = 1;",
  ]) {
    it(`uses one cursor for ${source.startsWith("Writing") ? "prose" : source.startsWith(">") ? "quoted code" : "code"}`, async () => {
      const fixture = TestBed.createComponent(MarkdownComponent);
      fixture.componentRef.setInput("source", source);
      fixture.componentRef.setInput("streaming", true);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll(".caret"),
      ).toHaveLength(1);
      fixture.componentRef.setInput("streaming", false);
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll(".caret"),
      ).toHaveLength(0);
    });
  }
});

describe("connected composer controls", () => {
  const capabilities: SessionChatState = {
    ...state,
    providerLocked: false,
    providers: [
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude Code" },
    ],
    controls: { plan: true, reasoning: true, fast: true },
    fast: false,
    model: "gpt",
    models: [
      {
        id: "gpt",
        label: "GPT",
        reasoningEfforts: ["low", "high"],
        supportsFastMode: true,
      },
    ],
    reasoning: "high",
    permissionMode: "auto",
    permissionModes: ["auto", "default"],
  };
  it("composes a single agent picker with advertised settings and harness-native permission IDs", async () => {
    const { fixture, root } = setup([], capabilities);
    await settle(fixture);
    expect(root.querySelector("ex-agent-picker")?.textContent).toContain("GPT");
    expect(root.querySelector("ex-permission-picker")?.textContent).toContain(
      "Auto",
    );
    expect(root.querySelectorAll(".bar ex-dropdown")).toHaveLength(0);
    expect(
      fixture.componentInstance.harnesses()[0]?.models[1]?.thinking,
    ).toEqual(["low", "high"]);
  });
  it("submits only the changed agent setting and retains a draft during reconciliation", async () => {
    const { fixture, bridge, complete } = setup([], capabilities);
    await settle(fixture);
    fixture.componentInstance.store.setDraft("Keep this draft");
    fixture.componentInstance.agentChanged({
      ...fixture.componentInstance.agent()!,
      thinking: "low",
    });
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith(
      "scope",
      expect.objectContaining({ action: { type: "reasoning", effort: "low" } }),
    );
    fixture.componentInstance.agentChanged({
      ...fixture.componentInstance.agent()!,
      fast: true,
    });
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.store.draft()).toBe("Keep this draft");
    complete();
    await settle(fixture);
  });
  it("keeps older engine settings usable without inventing thinking or fast capabilities", async () => {
    const { fixture } = setup();
    await settle(fixture);
    const composer = fixture.componentInstance.composer()!;
    expect(composer.reasoningAvailable()).toBe(false);
    expect(composer.fastAvailable()).toBe(false);
    expect(composer.agentLocked()).toBe(true);
  });
  it("makes archived agent settings read only", async () => {
    const { fixture, root, bridge } = setup([], capabilities);
    fixture.componentRef.setInput("archived", true);
    await settle(fixture);
    expect(
      root.querySelector<HTMLButtonElement>("ex-agent-picker > button")
        ?.disabled,
    ).toBe(true);
    fixture.componentInstance.agentChanged({
      ...fixture.componentInstance.agent()!,
      fast: true,
    });
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });
});
