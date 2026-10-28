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

function setup(items: readonly SessionChatItem[] = []) {
  let page: SessionChatPage = {
    taskId: 1,
    sessionId: 2,
    cursor: "cursor",
    reset: true,
    before: null,
    items,
    events: [],
    state,
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
    publish: (next: SessionChatPage) => {
      page = next;
    },
    complete: () => resolve({ ok: true, value: { accepted: true } }),
  };
}

describe("connected chat reply rendering", () => {
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
