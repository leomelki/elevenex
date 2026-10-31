import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendResult,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
  SessionChatCommandReply,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "../backend/backend-client.service";
import { SessionChatDrafts } from "./session-chat-drafts";
import { SessionChatComponent } from "./session-chat.component";
import { MarkdownComponent, NowLineComponent, PresetCreatorComponent } from "../conversation";

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
  let resolve!: (value: BackendResult<SessionChatCommandReply>) => void;
  const bridge = {
    sessionChatRead: vi.fn(async () => ({ ok: true as const, value: page })),
    sessionChatCommand: vi.fn(
      () =>
        new Promise<BackendResult<SessionChatCommandReply>>((yes) => {
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
    complete: (
      result: BackendResult<SessionChatCommandReply> = {
        ok: true,
        value: { accepted: true },
      },
    ) => resolve(result),
  };
}

describe("connected chat reply rendering", () => {
  it("renders the designed outcome after the answer and routes Review and a file chip to their reply", async () => {
    const { fixture, root } = setup([
      item("u", "user", "Create a test file"),
      item("a", "assistant", "Created skill-test.txt with a short test message."),
      { ...item("capture", "system", ""), changes: { total: 1, files: [{ path: "skill-test.txt", status: "A", add: 1, del: 0 }] } },
    ]);
    const review = vi.fn(); fixture.componentInstance.reviewRequested.subscribe(review);
    await settle(fixture);
    const chip = root.querySelector<HTMLButtonElement>("ex-file-chip button")!;
    expect(chip.textContent).toContain("skill-test.txt"); expect(chip.textContent).toContain("+1");
    expect(root.querySelector("ex-turn .answer")!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    chip.click();
    expect(review).toHaveBeenLastCalledWith({ scopeId: "scope", taskId: 1, sessionId: 2, turnId: "u", path: "skill-test.txt" });
    root.querySelectorAll<HTMLButtonElement>("ex-turn footer button").forEach(button => { if (button.textContent?.trim() === "Review") button.click(); });
    expect(review).toHaveBeenLastCalledWith({ scopeId: "scope", taskId: 1, sessionId: 2, turnId: "u" });
  });

  it("retains separate tool names, output and failures when live work becomes saved history", async () => {
    const items = [
      item("u", "user", "Check the code"),
      { ...item("read:tool_use", "tool_use", ""), toolId: "read", toolKind: "read", toolName: "Read", input: '{"file_path":"package.json"}' },
      { ...item("read:tool_result", "tool_result", '{"name":"example"}'), toolId: "read" },
      { ...item("test:tool_use", "tool_use", ""), toolId: "test", toolKind: "bash", toolName: "Bash", input: '{"command":"pnpm test"}' },
      { ...item("test:tool_result", "tool_result", "FAIL retry.spec.ts"), toolId: "test", error: true },
    ];
    const { fixture, root, publish } = setup(items, { ...state, phase: "running" });
    await settle(fixture);
    publish({ taskId: 1, sessionId: 2, cursor: "saved", reset: true, before: null,
      items: [...items, item("answer", "assistant", "The test failed; the output is retained.")], events: [], state });
    await fixture.componentInstance.store.refresh();
    await settle(fixture);
    const work = root.querySelector<HTMLButtonElement>("ex-turn .work")!;
    if (work.getAttribute("aria-expanded") === "false") work.click();
    await settle(fixture);
    const tools = root.querySelectorAll("ex-tool-step");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.querySelector(".verb")?.textContent).toBe("Read");
    expect(tools[1]?.querySelector(".verb")?.textContent).toBe("Bash");
    expect(tools[0]?.querySelector("section.failed")).toBeNull();
    expect(tools[1]?.querySelector("section.failed")).not.toBeNull();
    tools[1]?.querySelector<HTMLButtonElement>(".head")?.click();
    await settle(fixture);
    expect(tools[1]?.querySelector("pre")?.textContent).toContain("FAIL retry.spec.ts");
    expect(root.textContent).not.toContain("Script completed");
  });

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
  const savedPresets = [
    { id: 'deep', name: 'Deep work', provider: 'codex', providerLabel: 'Codex', model: 'gpt', modelLabel: 'GPT', reasoning: 'high', fast: false },
    { id: 'quick', name: 'Quick pass', provider: 'codex', providerLabel: 'Codex', model: 'gpt', modelLabel: 'GPT', reasoning: 'low', fast: true },
  ];
  it.each([
    { reasoning: 'high', fast: false },
    { reasoning: 'low', fast: true },
  ])('opens Custom with the current mix ($reasoning thinking, fast=$fast) without changing the chat', async ({ reasoning, fast }) => {
    const chatState = { ...capabilities, presets: savedPresets, reasoning, fast };
    const { fixture, root, bridge } = setup([], chatState);
    await settle(fixture);
    fixture.componentInstance.store.setDraft('Keep my message');
    const custom = root.querySelector<HTMLButtonElement>('ex-preset-card button.custom')!;
    custom.focus(); custom.click(); await settle(fixture);
    expect(document.querySelector('.agent-settings')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('.preset-creator input')?.value).toBe('');
    expect(document.querySelector('.preset-creator button[aria-label="Model: GPT"]')).not.toBeNull();
    expect(document.querySelector('.preset-creator [aria-label="Thinking level"] [aria-checked="true"]')?.getAttribute('aria-label')).toBe(reasoning === 'high' ? 'High' : 'Low');
    expect(document.querySelector('.preset-creator [role="switch"]')?.getAttribute('aria-checked')).toBe(String(fast));
    document.querySelector<HTMLButtonElement>(`.preset-creator [aria-label="Thinking level"] button[aria-label="${reasoning === 'high' ? 'Low' : 'High'}"]`)!.click();
    await settle(fixture);
    expect(fixture.componentInstance.store.state()).toMatchObject(chatState);
    document.querySelector('.preset-creator')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle(fixture);
    expect(document.querySelector('.preset-creator')).toBeNull();
    expect(document.activeElement).toBe(custom);
    expect(fixture.componentInstance.store.draft()).toBe('Keep my message');
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });
  it('keeps current selection distinct from the default and sends a guarded change with Undo', async () => {
    const before = { id: 'deep', provider: 'codex', defaultIds: ['deep'], revision: 'a'.repeat(64) };
    const after = { id: 'quick', provider: 'codex', defaultIds: ['quick'], revision: 'b'.repeat(64) };
    const { fixture, root, bridge, complete, publish } = setup([], { ...capabilities, presets: savedPresets, presetDefault: before });
    await settle(fixture);
    fixture.componentInstance.store.setDraft('Keep my message');
    const changing = fixture.componentInstance.presetFlow.setDefault('quick');
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith('scope', expect.objectContaining({ action: {
      type: 'preset-default', id: 'quick', expectedProvider: 'codex', expectedRevision: before.revision,
    } }));
    publish({ taskId: 1, sessionId: 2, cursor: 'new', reset: true, before: null, items: [], events: [], state: { ...capabilities, presets: savedPresets, presetDefault: after, reasoning: 'low', fast: true } });
    complete({ ok: true, value: { accepted: true, defaultChange: { before, after } } });
    await changing; await settle(fixture);
    expect(root.querySelector('.default-preset')?.textContent).toContain('Quick pass');
    expect(root.querySelector('ex-preset-card .default')?.closest('button')?.textContent).toContain('Quick pass');
    expect(fixture.componentInstance.store.draft()).toBe('Keep my message');
    const undo = fixture.componentInstance.presetFlow.undoDefault();
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith('scope', expect.objectContaining({ action: {
      type: 'preset-default-restore', provider: 'codex', defaultIds: ['deep'], expectedRevision: after.revision,
    } }));
    complete(); await undo; await settle(fixture);
    expect(fixture.componentInstance.presetFlow.defaultNoticeOpen()).toBe(false);
  });
  it('applies a whole preset in one command, retaining typing and the welcome during reconciliation', async () => {
    const { fixture, root, bridge, publish, complete } = setup([], { ...capabilities, presets: savedPresets });
    await settle(fixture);
    fixture.componentInstance.store.setDraft('Keep my question');
    const choosing = fixture.componentInstance.presetFlow.selectPreset('quick');
    fixture.detectChanges();
    expect(root.querySelectorAll('ex-preset-picker button:disabled')).toHaveLength(3);
    expect(root.querySelector('.start')).not.toBeNull();
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith('scope', expect.objectContaining({ action: { type: 'preset', id: 'quick', expectedProvider: 'codex' } }));
    publish({ taskId: 1, sessionId: 2, cursor: 'quick', reset: true, before: null, items: [], events: [], state: { ...capabilities, presets: savedPresets, reasoning: 'low', fast: true } });
    complete(); await choosing; await settle(fixture);
    expect(root.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent).toContain('Quick pass');
    expect(fixture.componentInstance.store.draft()).toBe('Keep my question');
    expect(document.activeElement).toBe(root.querySelector('textarea'));
  });
  it('retains the chosen identity when two named presets share the same mix', async () => {
    const identical = { ...savedPresets[0]!, id: 'other', name: 'Same mix, different purpose' };
    const { fixture, root, complete } = setup([], { ...capabilities, presets: [...savedPresets, identical] });
    await settle(fixture);
    const choosing = fixture.componentInstance.presetFlow.selectPreset('other');
    complete(); await choosing; await settle(fixture);
    expect(root.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent).toContain('Same mix, different purpose');
  });
  it('offers a keyboard-operated default choice without submitting or saving until Create', async () => {
    const fixture = TestBed.createComponent(PresetCreatorComponent);
    fixture.componentRef.setInput('initial', { mark: 'Cx', harness: 'codex', model: 'gpt' });
    fixture.componentRef.setInput('defaultAvailable', true);
    fixture.componentRef.setInput('harnesses', [{ id: 'codex', label: 'Codex', mark: 'Cx', models: [{ id: 'gpt', label: 'GPT', thinking: [] }] }]);
    const submissions = vi.fn(); fixture.componentInstance.submitted.subscribe(submissions);
    await settle(fixture);
    const keep = document.querySelector<HTMLButtonElement>('.default-choice button[aria-label="Keep current"]')!;
    const use = document.querySelector<HTMLButtonElement>('.default-choice button[aria-label="Use this preset"]')!;
    expect(keep.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.preset-creator input[type="checkbox"]')).toBeNull();
    keep.focus(); keep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await settle(fixture);
    expect(use.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(use);
    expect(submissions).not.toHaveBeenCalled();
    fixture.componentRef.setInput('busy', true); await settle(fixture);
    expect(keep.disabled).toBe(true); expect(use.disabled).toBe(true);
    keep.click(); expect(fixture.componentInstance.useAsDefault()).toBe(true);
    fixture.componentRef.setInput('busy', false); await settle(fixture);
    fixture.componentInstance.name.set('Review');
    document.querySelector<HTMLFormElement>('.preset-creator')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(submissions).toHaveBeenCalledWith(expect.objectContaining({ preset: 'Review', default: true }));
  });
  it('starts a fresh creator draft when reopened before the previous exit completes', async () => {
    const { fixture } = setup([], { ...capabilities, presets: savedPresets });
    await settle(fixture);
    fixture.componentInstance.presetFlow.openPresetCreator(); await settle(fixture);
    const oldName = document.querySelector<HTMLInputElement>('.preset-creator input')!;
    oldName.value = 'Discard this draft'; oldName.dispatchEvent(new Event('input'));
    fixture.componentInstance.presetFlow.creatorOpen.set(false);
    fixture.componentInstance.presetFlow.openPresetCreator(); await settle(fixture);
    const freshName = document.querySelector<HTMLInputElement>('.preset-creator input')!;
    expect(freshName).not.toBe(oldName); expect(freshName.value).toBe('');
  });
  it('creates a named draft with duplicate validation and never writes when cancelled', async () => {
    const { fixture, bridge } = setup([], { ...capabilities, presets: savedPresets });
    await settle(fixture);
    fixture.componentInstance.presetFlow.openPresetCreator(); await settle(fixture);
    const name = document.querySelector<HTMLInputElement>('ex-preset-creator input, .preset-creator input')!;
    name.value = ' DEEP WORK '; name.dispatchEvent(new Event('input')); await settle(fixture);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('.preset-creator button[type="submit"]')?.disabled).toBe(true);
    name.value = 'Review'; name.dispatchEvent(new Event('input')); await settle(fixture);
    expect(name.getAttribute('aria-invalid')).toBe('false');
    fixture.componentInstance.presetFlow.creatorOpen.set(false); await settle(fixture);
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });
  it('handles Option digit keys from the composer and ignores them after the session starts', async () => {
    const { fixture, root, bridge, complete } = setup([], { ...capabilities, presets: savedPresets });
    await settle(fixture);
    const event = new KeyboardEvent('keydown', { key: '™', code: 'Digit2', altKey: true, bubbles: true, cancelable: true });
    root.querySelector('textarea')!.dispatchEvent(event); fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
    complete(); await settle(fixture);
    fixture.componentInstance.store.state.update(state => state && ({ ...state, providerLocked: true })); fixture.detectChanges();
    root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true, bubbles: true }));
    expect(bridge.sessionChatCommand).toHaveBeenCalledTimes(1);
    expect(root.querySelector('ex-preset-picker')).toBeNull();
  });
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
  for (const accepted of [true, false]) {
    it(`keeps the connected agent menu open after a ${accepted ? "successful" : "rejected"} harness change`, async () => {
      const { fixture, root, bridge, publish, complete } = setup(
        [],
        capabilities,
      );
      await settle(fixture);
      fixture.componentInstance.store.setDraft("Keep this draft");
      const trigger = root.querySelector<HTMLButtonElement>(
        "ex-agent-picker > button",
      )!;
      trigger.focus();
      trigger.click();
      await settle(fixture);
      const surface = document.querySelector<HTMLElement>(".agent-settings")!;
      const claude = surface.querySelector<HTMLButtonElement>(
        '[aria-label="Harness"] button[aria-label="Claude Code"]',
      )!;
      claude.focus();
      claude.click();
      await settle(fixture);
      expect(surface.getAttribute("aria-busy")).toBe("true");
      expect(surface.contains(document.activeElement)).toBe(true);
      expect(bridge.sessionChatCommand).toHaveBeenCalledWith(
        "scope",
        expect.objectContaining({
          action: {
            type: "provider",
            provider: "claude",
            expectedProvider: "codex",
          },
        }),
      );
      if (accepted)
        publish({
          taskId: 1,
          sessionId: 2,
          cursor: "claude",
          reset: true,
          before: null,
          items: [],
          events: [],
          state: {
            ...capabilities,
            provider: "claude",
            model: "sonnet",
            models: [{ id: "sonnet", label: "Sonnet" }],
          },
        });
      complete(
        accepted
          ? { ok: true, value: { accepted: true } }
          : {
              ok: false,
              error: {
                code: "http",
                status: 409,
                message: "Harness unavailable",
              },
            },
      );
      await settle(fixture);
      expect(document.querySelector(".agent-settings")).toBe(surface);
      expect(surface.getAttribute("aria-busy")).toBe("false");
      expect(surface.contains(document.activeElement)).toBe(true);
      expect(
        surface.querySelector('[aria-label^="Model:"]')?.textContent,
      ).toContain(accepted ? "Sonnet" : "GPT");
      expect(fixture.componentInstance.store.draft()).toBe("Keep this draft");
      surface.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle(fixture);
      expect(document.querySelector(".agent-settings")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  }
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

describe("connected subscription quota", () => {
  it("renders live usage and removes quota when an API-key snapshot replaces it", async () => {
    const usage = {
      provider: "codex" as const,
      planName: "Plus",
      status: "warning" as const,
      updatedAt: new Date().toISOString(),
      windows: [{ id: "primary", label: "5-hour limit", remainingPercentage: 12, resetsAt: Math.floor(Date.now() / 1000) + 3600 }],
    };
    const { fixture, root, publish } = setup([], { ...state, planUsage: usage });
    await settle(fixture);
    expect(root.querySelector("ex-agent-plan-meter")?.getAttribute("aria-label")).toContain("12%");
    expect(root.querySelector("ex-agent-usage-notice")?.textContent).toContain("12% of your 5-hour limit left");
    fixture.componentInstance.store.setDraft("Keep this draft");
    publish({ taskId: 1, sessionId: 2, cursor: "new", reset: false, items: [], events: [], before: null, state: { ...state, planUsage: null } });
    fixture.componentInstance.store.refresh();
    await settle(fixture);
    expect(root.querySelector("ex-agent-plan-meter")).toBeNull();
    expect(root.querySelector("ex-agent-usage-notice .notice")).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this draft");
  });
});
