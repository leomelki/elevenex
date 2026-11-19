import { TestBed } from "@angular/core/testing";
import type {
  SessionChatItem,
  BackendResult,
  SessionChatAgentPage,
  SessionChatAgentRead,
} from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { SessionAgentComponent } from "./session-agent.component";

const page = (agentId: string): SessionChatAgentPage => ({
  agentId,
  label: agentId,
  status: "waiting",
  prompt: "",
  model: null,
  context: null,
  items: [],
  before: null,
  availability: "starting",
  message: "Waiting for the first message",
});
beforeEach(() =>
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
);
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});

it("cancels obsolete child reads and rejects replies after navigation and closing", async () => {
  const pending = new Map<
    string,
    (result: BackendResult<SessionChatAgentPage>) => void
  >();
  const client = {
    agent: vi.fn(
      (_scope: string, input: SessionChatAgentRead) =>
        new Promise<BackendResult<SessionChatAgentPage>>((resolve) =>
          pending.set(input.agentId, resolve),
        ),
    ),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: SessionChatClient, useValue: client }],
  });
  const fixture = TestBed.createComponent(SessionAgentComponent);
  fixture.componentRef.setInput("selection", {
    scopeId: "scope",
    taskId: 1,
    sessionId: 2,
  });
  fixture.componentRef.setInput("agentId", "old");
  fixture.detectChanges();
  fixture.componentRef.setInput("agentId", "new");
  fixture.detectChanges();
  pending.get("old")!({ ok: true, value: page("old") });
  await Promise.resolve();
  expect(fixture.componentInstance.page()).toBeNull();
  expect(client.cancel).toHaveBeenCalledOnce();
  fixture.componentInstance.close();
  pending.get("new")!({ ok: true, value: page("new") });
  await Promise.resolve();
  expect(fixture.componentInstance.page()).toBeNull();
  expect(client.cancel).toHaveBeenCalledTimes(2);
});

it("keeps the task title primary and the nickname secondary when inspecting completed work", async () => {
  const client = {
    agent: vi.fn(async () => ({ ok: true as const, value: {
      ...page('child'), title: 'Review retry handling', agentName: 'James', role: 'reviewer', status: 'completed' as const,
    } })),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: client }] });
  const fixture = TestBed.createComponent(SessionAgentComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 2 });
  fixture.componentRef.setInput('agentId', 'child');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const heading = document.querySelector('.agent-dialog h2');
  expect(heading?.textContent).toContain('Review retry handling');
  expect(heading?.querySelector('.role')?.textContent?.trim()).toBe('James');
  expect(heading?.textContent).not.toContain('reviewer');
  expect(document.querySelector('.agent-dialog .facts')?.textContent).toContain('reviewer');
});

it("stitches transcript pages, preserves loaded content offline and has explicit refresh", async () => {
  const client = {
    agent: vi.fn(async (_scope: string, input: SessionChatAgentRead) => ({
      ok: true as const,
      value: {
        ...page("child"),
        before: input.before ? null : "earlier",
        message: input.before ? "Earlier messages" : "Latest messages",
      },
    })),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: SessionChatClient, useValue: client }],
  });
  const fixture = TestBed.createComponent(SessionAgentComponent);
  fixture.componentRef.setInput("selection", {
    scopeId: "scope",
    taskId: 1,
    sessionId: 2,
  });
  fixture.componentRef.setInput("agentId", "child");
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  fixture.componentInstance.earlier();
  fixture.detectChanges();
  await fixture.whenStable();
  expect(fixture.componentInstance.page()?.message).toBe("Earlier messages");
  expect(fixture.componentInstance.hasNewer()).toBe(false);
  fixture.componentRef.setInput("unreachable", true);
  fixture.detectChanges();
  expect(fixture.componentInstance.page()?.message).toBe("Earlier messages");
  expect(client.agent).toHaveBeenCalledTimes(2);
  fixture.componentRef.setInput("unreachable", false);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.componentInstance.latest();
  fixture.detectChanges();
  await fixture.whenStable();
  expect(fixture.componentInstance.page()?.message).toBe("Latest messages");
  expect(fixture.componentInstance.hasNewer()).toBe(false);
});

it("shows the assignment once, pairs tool results with their calls and says where to answer", async () => {
  const item = (
    id: string,
    kind: SessionChatItem["kind"],
    text: string,
    extra: Partial<SessionChatItem> = {},
  ): SessionChatItem => ({
    id,
    kind,
    text,
    timestamp: "2026-11-11T10:00:00.000Z",
    toolId: null,
    toolName: null,
    toolKind: null,
    input: "",
    error: false,
    truncated: false,
    ...extra,
  });
  const client = {
    agent: vi.fn(async () => ({
      ok: true as const,
      value: {
        ...page("child"),
        status: "waiting" as const,
        availability: "available" as const,
        prompt: "Check the retry boundary.",
        items: [
          item("u", "user", "Check the retry boundary."),
          item("t", "tool_use", "", { toolId: "t", toolName: "Read", toolKind: "read", input: '{"file_path":"a.ts"}' }),
          item("r", "tool_result", "contents", { toolId: "t" }),
          item("a", "assistant", "The boundary is safe."),
        ],
      },
    })),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: SessionChatClient, useValue: client }],
  });
  const fixture = TestBed.createComponent(SessionAgentComponent);
  fixture.componentRef.setInput("selection", { scopeId: "scope", taskId: 1, sessionId: 2 });
  fixture.componentRef.setInput("agentId", "child");
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const dialog = document.querySelector<HTMLElement>(".agent-dialog")!;
  const entries = [...dialog.querySelectorAll<HTMLElement>(".entries > li")];
  expect(entries.map((entry) => entry.dataset["kind"])).toEqual(["tool_use", "assistant"]);
  expect(entries[0]!.querySelector("ex-tool-step")?.textContent).toContain("a.ts");
  expect(dialog.querySelector(".assignment")?.textContent).toContain("Check the retry boundary.");
  expect(dialog.textContent).toContain("Answer it in the main conversation.");
  expect(dialog.querySelector("footer button")).toBeNull();
});

it('keeps agent scrolling contiguous with at most 320 retained items and reloads evicted pages', async () => {
  const history: SessionChatItem[] = Array.from({ length: 4000 }, (_, i) => ({
    id: String(i), kind: 'assistant', text: `Message ${i}`, timestamp: '',
    toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false,
  }));
  const client = {
    agent: vi.fn(async (_scope: string, input: SessionChatAgentRead) => {
      const end = Number(input.before ?? history.length), start = Math.max(0, end - 80);
      return { ok: true as const, value: { ...page('child'), items: history.slice(start, end), before: start ? String(start) : null } };
    }),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: client }] });
  const fixture = TestBed.createComponent(SessionAgentComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 2 });
  fixture.componentRef.setInput('agentId', 'child'); fixture.detectChanges(); await fixture.whenStable();
  const owner = fixture.componentInstance;
  for (let i = 0; i < 12; i++) {
    owner.earlier(); fixture.detectChanges(); await fixture.whenStable();
    const items = owner.page()!.items;
    expect(items.length).toBeLessThanOrEqual(320);
    expect(items.every((item, i) => !i || Number(item.id) === Number(items[i - 1]!.id) + 1)).toBe(true);
  }
  expect(owner.hasNewer()).toBe(true);
  while (owner.hasNewer()) { owner.later(); fixture.detectChanges(); await fixture.whenStable(); }
  expect(owner.page()!.items.at(-1)?.id).toBe('3999');
  expect(owner.page()!.items.length).toBeLessThanOrEqual(320);
});


it("forwards shell copies and reports native command failures in delegated work", async () => {
  const call: SessionChatItem = { id: "shell", kind: "tool_use", text: "", timestamp: "", toolId: "shell", toolName: "Bash", toolKind: "bash", input: '{"command":"pnpm test"}', error: false, truncated: false };
  const client = {
    agent: vi.fn(async () => ({ ok: true as const, value: { ...page("child"), status: "completed" as const, availability: "available" as const, items: [call, { ...call, id: "result", kind: "tool_result" as const, text: "failure details", execution: { exitCode: 1 } }] } })),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: client }] });
  const fixture = TestBed.createComponent(SessionAgentComponent);
  fixture.componentRef.setInput("selection", { scopeId: "scope", taskId: 1, sessionId: 2 });
  fixture.componentRef.setInput("agentId", "child");
  fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  const dialog = document.querySelector<HTMLElement>(".agent-dialog")!;
  expect(dialog.querySelector("ex-tool-step section.failed")).not.toBeNull();
  dialog.querySelector<HTMLButtonElement>("ex-tool-step .head")!.click(); fixture.detectChanges();
  const copies: string[] = []; fixture.componentInstance.copyRequested.subscribe(text => copies.push(text));
  dialog.querySelector<HTMLButtonElement>('[aria-label="Copy captured output"]')!.click();
  expect(copies).toEqual(["failure details"]);
  fixture.componentRef.setInput("copiedCode", "failure details"); fixture.detectChanges();
  expect(dialog.querySelector('[aria-label="Output copied"]')).not.toBeNull();
  fixture.destroy();
});
