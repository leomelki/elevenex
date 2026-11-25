import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendResult,
  SessionChatItem,
  SessionChatPage,
  SessionChatRead,
  SessionChatState,
  SessionChatCommandReply,
  SessionChatContentRead,
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
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
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

function setup(items: readonly SessionChatItem[] = [], chatState = state, initialRead?: Promise<BackendResult<SessionChatPage>>) {
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
    writeClipboardText: vi.fn<(text: string) => Promise<void>>(async () => undefined),
    sessionChatCatalog: vi.fn(async (_scope: string, input: { provider: string }) => ({
      ok: true as const,
      value: {
        provider: input.provider, label: input.provider,
        models: [{ id: "sonnet", label: "Sonnet", reasoningEfforts: ["low", "high"], supportsFastMode: false }],
        model: "sonnet", reasoning: "high", fast: false,
        reasoningAvailable: true, fastAvailable: false, error: null,
      },
    })),
    sessionChatMedia: vi.fn(async (_scope: string, input: { itemId: string; mediaId: string }) => ({ ok: true as const, value: { ...input, source: 'data:image/png;base64,iVBORw0KGgo=' } })),
    sessionChatRead: vi.fn<(scope: string, input: SessionChatRead) => Promise<BackendResult<SessionChatPage>>>(async () => {
      if (initialRead) { const pending = initialRead; initialRead = undefined; return pending; }
      return { ok: true as const, value: page };
    }),
    sessionChatContent: vi.fn(async (_scope: string, input: SessionChatContentRead) => ({ ok: true as const,
      value: { itemId: input.itemId, part: input.part, offset: input.offset, text: `Complete ${input.part} for ${input.itemId}`, total: 100, nextOffset: null } })),
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

describe("connected chat preset editing", () => {
  const editable = () => {
    const presets: NonNullable<SessionChatState["presets"]> = [0, 1].map(index => ({
      id: `preset-${index}`, name: `Preset ${index + 1}`, provider: "codex", providerLabel: "Codex",
      model: "test", modelLabel: "Test model", reasoning: null, fast: false,
    }));
    const chatState: SessionChatState = {
      ...state, providerLocked: false, presetEditing: true, presets,
      presetDefault: { provider: "codex", id: "preset-0", defaultIds: ["preset-0"], revision: "a".repeat(64) },
    };
    return setup([], chatState);
  };
  it("offers the default choice when editing, locking it on for the preset that already is the default", async () => {
    const { fixture, root } = editable();
    await settle(fixture);
    const choice = (label: string) => document.querySelector<HTMLButtonElement>(`.default-choice button[aria-label="${label}"]`)!;
    root.querySelector<HTMLButtonElement>("[data-flip='preset-0'] button.tile-action.edit")!.click();
    await settle(fixture);
    expect(choice("Use this preset").getAttribute("aria-checked")).toBe("true");
    expect(choice("Keep current").disabled).toBe(true);
    document.querySelector(".preset-creator")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(fixture);
    root.querySelector<HTMLButtonElement>("[data-flip='preset-1'] button.tile-action.edit")!.click();
    await settle(fixture);
    expect(choice("Keep current").getAttribute("aria-checked")).toBe("true");
    expect(choice("Keep current").disabled).toBe(false);
  });
  it("saves an edit, then makes the preset the default against the new revision", async () => {
    const { fixture, root, bridge, complete, publish } = editable();
    await settle(fixture);
    root.querySelector<HTMLButtonElement>("[data-flip='preset-1'] button.tile-action.edit")!.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('.default-choice button[aria-label="Use this preset"]')!.click();
    await settle(fixture);
    document.querySelector(".preset-creator")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(fixture);
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", expect.objectContaining({ action: expect.objectContaining({ type: "preset-update", id: "preset-1" }) }));
    const next = { provider: "codex", id: "preset-0", defaultIds: ["preset-0"], revision: "c".repeat(64) };
    publish({ taskId: 1, sessionId: 2, cursor: "new", reset: true, before: null, items: [], events: [], state: { ...state, providerLocked: false, presetEditing: true, presets: fixture.componentInstance.store.state()!.presets, presetDefault: next } });
    complete(); await settle(fixture);
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", expect.objectContaining({ action: { type: "preset-default", id: "preset-1", expectedProvider: "codex", expectedRevision: next.revision } }));
    complete(); await settle(fixture);
  });
  it("opens individual preset edits separately from grid editing and keeps the composer draft", async () => {
    const presets: NonNullable<SessionChatState["presets"]> = Array.from({ length: 8 }, (_, index) => ({
      id: `preset-${index}`, name: `Preset ${index + 1}`, provider: "codex", providerLabel: "Codex",
      model: "test", modelLabel: "Test model", reasoning: null, fast: false,
    }));
    const chatState: SessionChatState = {
      ...state, providerLocked: false, presetEditing: true, presets,
      presetDefault: { provider: "codex", id: "preset-0", defaultIds: ["preset-0"], revision: "a".repeat(64) },
    };
    const { fixture, root, bridge, publish } = setup([], chatState);
    await settle(fixture);
    fixture.componentInstance.store.setDraft("Keep the draft");
    fixture.detectChanges();
    const headingActions = () => Array.from(root.querySelectorAll(".preset-heading button[data-preset-edit], .preset-heading button[data-preset-new]"))
      .map(button => button.textContent?.trim());
    expect(headingActions()).toEqual(["Edit", "New preset"]);
    expect(root.querySelector(".grip")).toBeNull();

    root.querySelector<HTMLButtonElement>("[data-flip='preset-0'] button.tile-action.edit")!.click();
    await settle(fixture);
    const name = document.querySelector<HTMLInputElement>(".preset-creator .identity input");
    expect(name?.value).toBe("Preset 1");
    expect(headingActions()).toEqual(["Edit", "New preset"]);
    expect(root.querySelector(".grip")).toBeNull();
    name!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(fixture);
    expect(document.querySelector(".preset-creator")).toBeNull();
    expect(headingActions()).toEqual(["Edit", "New preset"]);
    expect(root.querySelector("ex-composer")?.hasAttribute("inert")).toBe(false);

    root.querySelector<HTMLButtonElement>("[data-preset-edit]")!.click();
    await settle(fixture);
    expect(headingActions()).toEqual(["New preset", "Done"]);
    expect(root.querySelector("[data-preset-edit]")?.getAttribute("data-variant")).toBe("primary");
    expect(root.querySelectorAll(".full .grip")).toHaveLength(6);
    expect(root.querySelectorAll(".slim-grid .grip")).toHaveLength(2);
    expect(root.querySelectorAll(".preset-tile button[draggable='true']")).toHaveLength(8);
    expect(root.querySelector("[data-flip='preset-0'] .default")?.textContent).toBe("Default");
    expect(root.querySelector("ex-composer")?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(root.querySelector("[data-preset-edit]"));

    const slimCard = root.querySelector<HTMLButtonElement>(".slim-grid ex-preset-card button")!;
    slimCard.focus();
    slimCard.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(fixture);
    expect(headingActions()).toEqual(["Edit", "New preset"]);
    expect(root.querySelector(".grip")).toBeNull();
    expect(root.querySelector("ex-composer")?.hasAttribute("inert")).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>("ex-composer textarea")?.value).toBe("Keep the draft");
    expect(document.activeElement).toBe(root.querySelector("[data-preset-edit]"));

    root.querySelector<HTMLButtonElement>("[data-preset-edit]")!.click();
    publish({
      taskId: 1, sessionId: 2, cursor: "empty", reset: true, before: null, items: [], events: [],
      state: { ...chatState, presets: [], presetDefault: { provider: "codex", id: null, defaultIds: [], revision: "b".repeat(64) } },
    });
    await fixture.componentInstance.store.refresh();
    await settle(fixture);
    expect(headingActions()).toEqual(["New preset", "Done"]);
    expect(root.querySelector(".start")?.textContent).not.toContain("Choose your agent below");

    root.querySelector<HTMLButtonElement>("[data-preset-edit]")!.click();
    await settle(fixture);
    expect(headingActions()).toEqual(["New preset"]);
    expect(document.activeElement).toBe(root.querySelector("[data-preset-new]"));
    expect(root.querySelector<HTMLTextAreaElement>("ex-composer textarea")?.value).toBe("Keep the draft");
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });
});

describe("connected chat reply rendering", () => {
  it('loads the leading prompt attachment outside the raw transcript page', async () => {
    const { fixture, bridge } = setup([], state, Promise.resolve({ ok: true, value: {
      taskId: 1, sessionId: 2, cursor: 'opening', reset: true, before: 'a1', events: [], state,
      leadingPrompt: { ...item('u1', 'user', 'Inspect this screenshot'), media: [
        { id: 'capture', path: '/capture.png', caption: 'Screenshot', inline: true },
      ] },
      items: [item('a1', 'assistant', 'I inspected it.')],
    } }));
    await settle(fixture);
    expect(fixture.componentInstance.store.exchanges()[0]?.attachments?.[0]?.id).toBe('capture');
    expect(bridge.sessionChatMedia).toHaveBeenCalledWith('scope', expect.objectContaining({ itemId: 'u1', mediaId: 'capture' }));
  });

  it('retains loaded media when history paging compacts the reply out of its raw window', async () => {
    const clip = { ...item('video', 'tool_result', ''), media: [
      { kind: 'video' as const, id: 'clip', path: '/clip.webm', caption: 'Recording', inline: true },
    ] };
    const prompt = item('u1', 'user', 'Record this flow');
    const items = Array.from({ length: 320 }, (_, i) => item(`work-${i}`, 'system', 'Work'));
    items.splice(-2, 2, clip, item('answer', 'assistant', 'Completed'));
    const opening = { taskId: 1, sessionId: 2, cursor: 'opening', reset: true, before: 'work-0', events: [], state };
    const { fixture, root, bridge, publish } = setup([], state,
      Promise.resolve({ ok: true, value: { ...opening, leadingPrompt: prompt, items } }));
    bridge.sessionChatMedia.mockImplementation(async (_scope, input) => ({
      ok: true, value: { ...input, source: 'data:video/webm;base64,AAAA' },
    }));
    await settle(fixture);
    const video = root.querySelector('video');
    expect(video).not.toBeNull();
    publish({ ...opening, items: [prompt, item('earlier-work', 'system', 'Earlier work')], before: null });
    await fixture.componentInstance.store.older();
    await settle(fixture);
    expect(fixture.componentInstance.store.items().some(row => row.id === clip.id)).toBe(false);
    expect(root.querySelector('video')).toBe(video);
    expect(bridge.sessionChatMedia).toHaveBeenCalledTimes(1);
  });

  it('retains composer configuration and completed turn inputs through unrelated runtime activity', async () => {
    const { fixture, root, publish } = setup([
      item('u1', 'user', 'Earlier'), item('a1', 'assistant', 'Finished'),
      item('u2', 'user', 'Latest'), item('a2', 'assistant', 'Working'),
    ], { ...state, phase: 'running' });
    await settle(fixture);
    const owner = fixture.componentInstance;
    const before = { models: owner.models(), harnesses: owner.harnesses(), agent: owner.agent(), permissions: owner.permissions(), exchange: owner.store.exchanges()[0], turn: root.querySelector('ex-turn') };
    publish({ taskId: 1, sessionId: 2, cursor: 'updated', reset: false, before: null, items: [], events: [],
      state: { ...state, phase: 'running', activity: [{ id: 'work', label: 'Reading', detail: 'Current file' }] } });
    await owner.store.refresh(); await settle(fixture);
    expect(owner.models()).toBe(before.models);
    expect(owner.harnesses()).toBe(before.harnesses);
    expect(owner.agent()).toBe(before.agent);
    expect(owner.permissions()).toBe(before.permissions);
    expect(owner.store.exchanges()[0]).toBe(before.exchange);
    expect(root.querySelector('ex-turn')).toBe(before.turn);
  });
  it('shows a delayed, decorative skeleton on a cold open and replaces it with a retry on failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolve!: (result: BackendResult<SessionChatPage>) => void;
    const { fixture, root, bridge, publish } = setup([], state, new Promise(yes => { resolve = yes; }));
    await settle(fixture);
    const status = root.querySelector('ex-chat-loading [role="status"]')!;
    vi.advanceTimersByTime(149);
    fixture.detectChanges();
    expect(status.textContent).toBe('');
    expect(root.querySelector('ex-chat-loading .skeleton')).toBeNull();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(status.textContent).toBe('Loading conversation…');
    const skeleton = root.querySelector('ex-chat-loading .skeleton');
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.querySelector('button, input, textarea, [tabindex]')).toBeNull();
    expect(root.querySelector('ex-composer')).toBeNull();
    resolve({ ok: false, error: { code: 'transport', message: 'Connection interrupted' } });
    await settle(fixture);
    expect(status.textContent).toBe('');
    expect(root.querySelector('ex-chat-loading .skeleton')).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Connection interrupted');
    expect(root.querySelector('ex-composer')).toBeNull();
    publish({ taskId: 1, sessionId: 2, cursor: 'loaded', reset: true, before: null, events: [],
      state: { ...state, providerLocked: true }, items: [item('reply', 'assistant', 'Loaded reply')] });
    (root.querySelector('.opening button') as HTMLButtonElement).click();
    await settle(fixture);
    expect(bridge.sessionChatRead).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.opening')).toBeNull();
    expect(root.querySelector('ex-composer')).not.toBeNull();
    expect(root.querySelector('ex-turn')?.textContent).toContain('Loaded reply');
  });

  it('restarts the loading delay for a different session and shows its fast reply immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, root, bridge } = setup([], state, new Promise(() => undefined));
    await settle(fixture);
    vi.advanceTimersByTime(100);
    let resolve!: (result: BackendResult<SessionChatPage>) => void;
    bridge.sessionChatRead.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 3 });
    await settle(fixture);
    vi.advanceTimersByTime(100);
    fixture.detectChanges();
    expect(root.querySelector('ex-chat-loading .skeleton')).toBeNull();
    resolve({ ok: true, value: { taskId: 1, sessionId: 3, cursor: 'latest', reset: true, before: null, events: [],
      state, items: [item('reply', 'assistant', 'Latest reply')] } });
    await settle(fixture);
    expect(root.querySelector('ex-turn')?.textContent).toContain('Latest reply');
    expect(root.querySelector('ex-composer')).not.toBeNull();
    vi.advanceTimersByTime(50);
    fixture.detectChanges();
    expect(root.querySelector('ex-chat-loading .skeleton')).toBeNull();
  });

  it('renders a cached session immediately with fresh scroll ownership while its refresh waits', async () => {
    const { fixture, root, bridge } = setup([item('reply', 'assistant', 'Cached reply')]);
    await settle(fixture);
    const previous = fixture.componentInstance.chat()!.scroll();
    fixture.componentInstance.store.setDraft('Retain my writing');
    bridge.sessionChatRead.mockImplementation(() => new Promise(() => undefined));
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 3 });
    await settle(fixture);
    expect(root.querySelector('ex-composer')).toBeNull();
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 2 });
    await settle(fixture);
    expect(fixture.componentInstance.store.loading()).toBe(false);
    expect(root.querySelector('.opening')).toBeNull();
    expect(root.querySelector('ex-chat-loading .skeleton')).toBeNull();
    expect(root.querySelector('ex-turn')?.textContent).toContain('Cached reply');
    expect(bridge.sessionChatRead.mock.calls.at(-1)?.[1].after).toBe('cursor');
    expect(fixture.componentInstance.chat()!.scroll()).not.toBe(previous);
    expect(fixture.componentInstance.composer()!.draft()).toBe('Retain my writing');
  });

  it('opens a recently running session on fresh tool activity', async () => {
    const running = { ...state, phase: 'running' as const, canInterrupt: true };
    const prompt = item('prompt', 'user', 'Run verification');
    const tool = (id: string, command: string) => ({
      ...item(id, 'tool_use', ''), toolId: id, toolKind: 'bash', toolName: 'Bash',
      input: JSON.stringify({ command }),
    });
    const { fixture, root, bridge } = setup([prompt, tool('old-call', 'pnpm lint')], running);
    await settle(fixture);
    expect(root.querySelector('ex-tool-step')?.textContent).toContain('pnpm lint');
    fixture.componentInstance.store.setDraft('Retain my writing');
    bridge.sessionChatRead.mockImplementationOnce(() => new Promise(() => undefined));
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 3 });
    await settle(fixture);

    let resolve!: (result: BackendResult<SessionChatPage>) => void;
    bridge.sessionChatRead.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 2 });
    await settle(fixture);
    expect(root.querySelector('ex-tool-step')).toBeNull();
    expect(bridge.sessionChatRead.mock.calls.at(-1)?.[1].after).toBeUndefined();

    resolve({ ok: true, value: { taskId: 1, sessionId: 2, cursor: 'fresh', reset: true,
      before: null, events: [], state: running, items: [prompt, tool('new-call', 'pnpm build')] } });
    await settle(fixture);
    expect(root.querySelector('ex-tool-step')?.textContent).toContain('pnpm build');
    expect(root.querySelector('[data-work-step].step-enter')).toBeNull();
    expect(fixture.componentInstance.composer()!.draft()).toBe('Retain my writing');
  });

  it('releases seen-view foreground listeners on teardown', async () => {
    const windowAdded = vi.spyOn(window, 'addEventListener');
    const documentAdded = vi.spyOn(document, 'addEventListener');
    const windowRemoved = vi.spyOn(window, 'removeEventListener');
    const documentRemoved = vi.spyOn(document, 'removeEventListener');
    const { fixture } = setup(); await settle(fixture);
    const foreground = windowAdded.mock.calls.find(([type, listener]) => type === 'focus' &&
      documentAdded.mock.calls.some(([event, handler]) => event === 'visibilitychange' && handler === listener))?.[1];
    expect(foreground).toBeDefined(); fixture.destroy();
    expect(windowRemoved).toHaveBeenCalledWith('focus', foreground);
    expect(windowRemoved).toHaveBeenCalledWith('blur', foreground);
    expect(documentRemoved).toHaveBeenCalledWith('visibilitychange', foreground);
  });
  it('acknowledges a loaded reply only in the foreground, at the latest content, and outside inert layers', async () => {
    let focused = false;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const at = '2026-11-14T12:00:00.000Z';
    const { fixture, root, bridge, complete } = setup([item('answer', 'assistant', 'Finished working.')], { ...state, unseenCompletionAt: at });
    await settle(fixture);
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    root.setAttribute('inert', '');
    focused = true; window.dispatchEvent(new Event('focus')); await settle(fixture);
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    const scroll = fixture.componentInstance.chat()!.scroll()!;
    scroll.atEnd.set(false); root.removeAttribute('inert'); await settle(fixture);
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    scroll.atEnd.set(true); await settle(fixture);
    expect(bridge.sessionChatCommand).toHaveBeenCalledExactlyOnceWith('scope', { taskId: 1, sessionId: 2, action: { type: 'mark-seen', completionAt: at } });
    complete(); await settle(fixture);
    expect(fixture.componentInstance.store.state()?.unseenCompletionAt).toBeNull();
  });
  it('copies reply and code text through the native bridge and reports native failures', async () => {
    const text = '  café 👩🏽‍💻\n\t代码\r\n';
    const { fixture, root, bridge } = setup([item('answer', 'assistant', text)]);
    await settle(fixture);
    fixture.componentInstance.turnAction({ id: fixture.componentInstance.store.exchanges()[0]!.id, action: 'copy' });
    await settle(fixture);
    expect(bridge.writeClipboardText).toHaveBeenLastCalledWith(text);
    expect(fixture.componentInstance.store.notice()).toBe('Copied');
    await fixture.componentInstance.copy(text, true); await settle(fixture);
    expect(fixture.componentInstance.copiedCode()).toBe(text);
    bridge.writeClipboardText.mockRejectedValueOnce(new Error('Clipboard busy'));
    await fixture.componentInstance.copy('failed'); await settle(fixture);
    expect(root.textContent).toContain('Could not copy.');
    await fixture.componentInstance.copy('retry'); await settle(fixture);
    expect(fixture.componentInstance.store.error()).toBe('');
  });

  it.each(['navigation', 'destruction', 'newer-copy'] as const)('rejects late clipboard feedback after %s', async change => {
    const { fixture, bridge } = setup(); await settle(fixture);
    let finish!: () => void;
    bridge.writeClipboardText.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = fixture.componentInstance.copy('old', true);
    if (change === 'navigation') {
      fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 3 });
      await settle(fixture);
    } else if (change === 'destruction') fixture.destroy();
    else await fixture.componentInstance.copy('latest', true);
    finish(); await pending;
    expect(fixture.componentInstance.copiedCode()).toBe(change === 'newer-copy' ? 'latest' : null);
  });
  it.each(['text', 'input'] as const)('opens shortened tool %s in the bounded reader and switches to the paired receipt', async part => {
    const { root, fixture, bridge } = setup([
      item('u', 'user', 'Check the output'),
      { ...item('call', 'tool_use', ''), toolId: 'tool', toolKind: 'bash', input: '{"command":"pnpm test"}', truncated: true },
      { ...item('earlier-result', 'tool_result', 'An earlier receipt'), toolId: 'tool' },
      { ...item('result', 'tool_result', 'A shortened result'), toolId: 'tool', truncated: true },
      item('answer', 'assistant', 'Done.'),
    ]);
    await settle(fixture);
    root.querySelector<HTMLButtonElement>('.work')!.click();
    await settle(fixture);
    expect(root.querySelector('ex-tool-content')).toBeNull();
    root.querySelector<HTMLButtonElement>('ex-tool-step .head')!.click();
    await settle(fixture);
    const button = [...root.querySelectorAll<HTMLButtonElement>('.full-content button')].find(button => button.textContent?.includes(part === 'text' ? 'output' : 'input'))!;
    button.click(); await settle(fixture);
    expect(bridge.sessionChatContent).toHaveBeenLastCalledWith('scope', expect.objectContaining({ itemId: part === 'text' ? 'result' : 'call', part }));
    const other = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Tool content"] button')].find(button => button.textContent?.includes(part === 'text' ? 'Input' : 'Output'))!;
    other.click(); await settle(fixture);
    expect(bridge.sessionChatContent).toHaveBeenLastCalledWith('scope', expect.objectContaining({ itemId: part === 'text' ? 'call' : 'result', part: part === 'text' ? 'input' : 'text', offset: 0 }));
  });
  it.each(["idle", "running"] as const)(
    "keeps shortened tool inputs and results inside work during %s replies",
    async (phase) => {
      const tools = Array.from({ length: 12 }, (_, index) => [
        { ...item(`tool-${index}`, "tool_use", ""), toolId: `call-${index}`, toolKind: "bash", input: '{"command":"pnpm test"}', truncated: true },
        { ...item(`result-${index}`, "tool_result", "Tests passed\n… [display shortened]"), toolId: `call-${index}`, truncated: true },
      ]).flat();
      const { fixture, root } = setup([
        item("prompt", "user", "Check the changes"),
        ...tools,
        { ...item("orphan", "tool_result", "Earlier tool output"), truncated: true },
        item("answer", "assistant", "The changes are verified."),
      ], { ...state, phase });
      await settle(fixture);
      expect(root.textContent).not.toContain("Read full tool");
      expect(root.querySelector("ex-turn .answer")?.textContent).toContain("The changes are verified.");
      const work = root.querySelector<HTMLButtonElement>("ex-turn .work")!;
      if (work.getAttribute("aria-expanded") !== "true") {
        work.click(); await settle(fixture);
      }
      const heads = root.querySelectorAll<HTMLButtonElement>("ex-work-timeline ex-tool-step .head");
      heads[heads.length - 2]!.click();
      heads[heads.length - 1]!.click();
      await settle(fixture);
      expect(root.querySelector("ex-work-timeline")?.textContent).toContain("Tests passed");
      expect(root.querySelector("ex-work-timeline")?.textContent).toContain("Earlier tool output");
    },
  );

  it("retains full-message access for shortened assistant replies", async () => {
    const { fixture, root } = setup([
      item("prompt", "user", "Explain the changes"),
      { ...item("answer", "assistant", "A shortened reply"), truncated: true },
    ]);
    await settle(fixture);
    expect(root.querySelector("ex-turn .answer")?.textContent).toContain("A shortened reply");
    expect(root.querySelector("ex-chat-scroll .content > button[exButton]")?.textContent).toContain("Read full message");
  });

  it.each(["claude", "codex", "opencode", "pi", "custom-agent"])(
    "uses the %s harness identity for the reply mark",
    async (provider) => {
      const labels: Readonly<Record<string, string>> = {
        claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi",
      };
      const { fixture, root } = setup([
        item("prompt", "user", "Hello"),
        item("answer", "assistant", "Ready to help."),
      ], {
        ...state,
        provider,
        providers: Object.entries(labels).map(([id, label]) => ({ id, label })),
      });
      await settle(fixture);
      const mark = root.querySelector("ex-turn .mark");
      // Catalog labels name the agent; unlisted harnesses fall back to their ID.
      const name = labels[provider] ?? provider;
      expect(mark?.getAttribute("role")).toBe("img");
      expect(mark?.getAttribute("aria-label")).toBe(name);
      expect(mark?.getAttribute("title")?.startsWith(name)).toBe(true);
      expect(mark?.querySelector("ex-agent-mark")?.getAttribute("aria-hidden")).toBe("true");
      if (provider === "custom-agent") {
        expect(mark?.querySelector("svg")).toBeNull();
        expect(mark?.textContent?.trim()).toBe("CU");
      } else {
        expect(mark?.querySelector("svg path")).not.toBeNull();
        expect(mark?.textContent?.trim()).toBe("");
      }
    },
  );

  it('clears native input when typing and submitting before the next render', async () => {
    const { fixture, root, bridge, complete } = setup();
    await settle(fixture);
    const textarea = root.querySelector<HTMLTextAreaElement>('ex-composer textarea')!;
    textarea.value = 'Submit immediately';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(textarea.value).toBe('');
    expect(fixture.componentInstance.store.draft()).toBe('');
    expect(bridge.sessionChatCommand).toHaveBeenCalledOnce();
    complete();
    await settle(fixture);
  });

  it('restores the native input when a rejected message comes back before the next render', async () => {
    const { fixture, root, complete } = setup();
    await settle(fixture);
    const textarea = root.querySelector<HTMLTextAreaElement>('ex-composer textarea')!;
    textarea.value = 'Keep this draft';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(textarea.value).toBe('');
    complete({ ok: false, error: { code: 'outcome-unknown', message: 'Check delivery' } });
    await settle(fixture);
    expect(textarea.value).toBe('Keep this draft');
    expect(fixture.componentInstance.store.uncertain()).toBe('Check delivery');
  });

  it("keeps the live turn mounted when its durable prompt receipt arrives with completion", async () => {
    const { fixture, root, publish, complete } = setup();
    await settle(fixture);
    const sending = fixture.componentInstance.store.submit({ text: "Hi", intent: "send", context: [] });
    fixture.detectChanges();
    publish({
      taskId: 1, sessionId: 2, cursor: "streaming", reset: false, before: null, items: [],
      events: [{ type: "item", item: item("answer", "assistant", "Hello") }],
      state: { ...state, phase: "running" },
    });
    await fixture.componentInstance.store.refresh(); await settle(fixture);
    const turn = root.querySelector("ex-turn");
    const answer = root.querySelector("ex-turn .answer");
    expect(turn?.textContent).toContain("Working");
    publish({
      taskId: 1, sessionId: 2, cursor: "completed", reset: false, before: null, items: [],
      events: [{ type: "item", item: item("durable-prompt", "user", "Hi") }],
      state,
    });
    await fixture.componentInstance.store.refresh(); await settle(fixture);
    expect(root.querySelector("ex-turn")).toBe(turn);
    expect(root.querySelector("ex-turn .answer")).toBe(answer);
    expect(root.querySelector("ex-turn .work-region[inert]")?.textContent).toContain("Working");
    expect(fixture.componentInstance.store.exchanges().at(-1)?.id).toBe("durable-prompt");
    expect(root.querySelector("[data-user-message]")?.getAttribute("data-user-message")).toBe("durable-prompt");
    complete(); await sending;
    await fixture.componentInstance.store.refresh(); await settle(fixture);
    expect(root.querySelector("ex-turn")).toBe(turn);
  });
  it("opens hydrated sessions at the end and preserves reading position on refresh", async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const { fixture, root } = setup([
      item("prompt", "user", "An existing conversation"),
      item("reply", "assistant", "The latest reply"),
    ]);
    await settle(fixture);
    const viewport = root.querySelector<HTMLDivElement>("ex-chat-scroll .viewport")!;
    expect(viewport.scrollTop).toBe(2000);

    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
    await fixture.componentInstance.store.refresh();
    await settle(fixture);
    expect(viewport.scrollTop).toBe(100);
  });

  it("jumps to the end after a switched session's delayed history renders, including reopening", async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const { fixture, root, bridge } = setup([item("first", "user", "First session")]);
    await settle(fixture);
    let viewport = root.querySelector<HTMLDivElement>("ex-chat-scroll .viewport")!;
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
    let resolveRead!: (reply: { ok: true; value: SessionChatPage }) => void;
    bridge.sessionChatRead.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    fixture.componentRef.setInput("selection", { scopeId: "scope", taskId: 1, sessionId: 3 });
    await settle(fixture);
    expect(fixture.componentInstance.store.loading()).toBe(true);
    resolveRead({ ok: true, value: {
      taskId: 1, sessionId: 3, cursor: "next", reset: true, before: null,
      items: [item("second", "user", "Second session")], events: [], state,
    } });
    await settle(fixture);
    viewport = root.querySelector<HTMLDivElement>("ex-chat-scroll .viewport")!;
    expect(viewport.scrollTop).toBe(3000);

    viewport.scrollTop = 200;
    viewport.dispatchEvent(new Event("scroll"));
    fixture.componentRef.setInput("selection", { scopeId: "scope", taskId: 1, sessionId: 2 });
    await settle(fixture);
    viewport = root.querySelector<HTMLDivElement>("ex-chat-scroll .viewport")!;
    expect(viewport.scrollTop).toBe(3000);
  });

  it('renders orphan structured receipts as tool evidence and leaves missing completion unknown', async () => {
    const { fixture, root } = setup([
      { ...item('orphan', 'tool_result', '{"title":"Retry safety","owner":"Payments"}'), toolKind: 'mcp', toolName: 'Issue lookup', toolId: 'outside-window' },
      { ...item('attempt', 'tool_use', ''), toolKind: 'edit', toolName: 'Edit', toolId: 'unfinished', input: '{"file_path":"retry.ts","old_string":"old()","new_string":"new()"}' },
    ]);
    await settle(fixture);
    const work = root.querySelector<HTMLButtonElement>('ex-turn .work')!;
    work.click(); await settle(fixture);
    const tools = root.querySelectorAll('ex-tool-step');
    expect(tools).toHaveLength(2);
    tools[0]!.querySelector<HTMLButtonElement>('.head')!.click();
    await settle(fixture);
    expect(tools[0]?.querySelector('.tool-preview')?.textContent).toContain('Retry safety');
    expect(tools[0]?.querySelector('.tool-preview')?.textContent).not.toContain('{');
    expect(tools[1]?.querySelector('.verb')?.textContent).toBe('Attempted to edit');
    expect(tools[1]?.querySelector('[aria-label="Completion unknown"]')).not.toBeNull();
    expect(tools[1]?.querySelector('ex-status-glyph')).toBeNull();
    expect(root.querySelector('ex-turn .summary-facts')?.textContent).not.toContain('edit');
  });

  it("routes Markdown files and folders to Code with the selected conversation", async () => {
    const { fixture, root } = setup([
      item("u", "user", "Where are the files?"),
      item("a", "assistant", "[Source](./src/main.ts:12:3) [Folder](/tmp/notes/) [Report](file:///tmp/report.md#L2)"),
    ]);
    const open = vi.fn(), review = vi.fn();
    fixture.componentInstance.fileLinkRequested.subscribe(open);
    fixture.componentInstance.reviewRequested.subscribe(review);
    await settle(fixture);
    const paths = ["./src/main.ts:12:3", "/tmp/notes/", "file:///tmp/report.md#L2"];
    const links = root.querySelectorAll<HTMLButtonElement>("ex-markdown-inline button.file");
    expect(links).toHaveLength(paths.length);
    links.forEach((link, index) => {
      link.click();
      expect(open).toHaveBeenLastCalledWith({ scopeId: "scope", taskId: 1, sessionId: 2, path: paths[index] });
    });
    expect(review).not.toHaveBeenCalled();
  });

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
    tools[0]!.querySelector<HTMLButtonElement>('.head')!.click();
    await settle(fixture);
    expect(tools[0]?.querySelector(".verb")?.textContent).toBe("Read");
    expect(tools[1]?.querySelector(".verb")?.textContent).toBe("Failed to run");
    expect(tools[0]?.querySelector("section.failed")).toBeNull();
    expect(tools[1]?.querySelector("section.failed")).not.toBeNull();
    tools[1]?.querySelector<HTMLButtonElement>(".head")?.click();
    await settle(fixture);
    expect(tools[1]?.querySelector(".tool-content")?.textContent).toContain("FAIL retry.spec.ts");
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
      if (phase === "idle") {
        expect(turn.querySelector(".facts")?.textContent).toContain("1 command");
      } else {
        expect(turn.querySelector(".facts")).toBeNull();
      }
      expect(turn.querySelectorAll(".caret")).toHaveLength(0);
      const head = tool.querySelector<HTMLButtonElement>(".head")!;
      expect(head.getAttribute("aria-expanded")).toBe("false");
      head.click();
      await settle(fixture);
      expect(head.getAttribute("aria-expanded")).toBe("true");
      expect(tool.querySelector(".tool-content")?.textContent).toContain("All tests passed");
      toggle.click();
      await settle(fixture);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(tool.closest("ex-fold[inert]")).not.toBeNull();
      expect(turn.querySelector(".group")?.getAttribute("aria-label")).toContain("1 command");
      expect(answer.closest("[inert]")).toBeNull();
    });
  }
  it("shows final text directly when only a system record follows it", async () => {
    const { fixture, root } = setup([
      item("u", "user", "Hi"),
      item("a", "assistant", "Here is the final reply."),
      item("s", "system", "Completed"),
    ]);
    await settle(fixture);
    fixture.detectChanges();
    expect(root.querySelector("ex-turn .work")).toBeNull();
    expect(root.querySelector("ex-turn ex-tool-step")).toBeNull();
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
  it('requests browser picking only for a saved session', async () => {
    const { fixture } = setup();
    await settle(fixture);
    const picked = vi.fn();
    fixture.componentInstance.browserPickRequested.subscribe(picked);
    fixture.componentInstance.pickBrowserElement('tab-1');
    expect(picked).toHaveBeenCalledWith({ scopeId: 'scope', taskId: 1, sessionId: 2, tabId: 'tab-1' });
    picked.mockClear();
    fixture.componentRef.setInput('selection', null);
    fixture.componentInstance.pickBrowserElement('tab-1');
    expect(picked).not.toHaveBeenCalled();
  });
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
    // The creator edits the mix with the composer's own agent menu.
    expect(document.querySelector('.preset-creator [role="option"][aria-selected="true"]')?.textContent).toContain('GPT');
    const slider = document.querySelector<HTMLInputElement>('.preset-creator input[type="range"]')!;
    expect(slider.getAttribute('aria-valuetext')).toBe(reasoning === 'high' ? 'High' : 'Low');
    expect(document.querySelector('.preset-creator button[aria-label="Fast mode"]')?.getAttribute('aria-pressed')).toBe(String(fast));
    slider.value = reasoning === 'high' ? '0' : '1';
    slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(slider.getAttribute('aria-valuetext')).toBe(reasoning === 'high' ? 'Low' : 'High');
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
  it.each([true, false])('starts with Use this preset when no default exists and respects opt-in=%s on Create', async (useDefault) => {
    const before = { id: null, provider: 'codex', defaultIds: [], revision: 'a'.repeat(64) };
    const { fixture, root, bridge, complete } = setup([], { ...capabilities, presets: [], presetDefault: before });
    await settle(fixture);
    root.querySelector<HTMLButtonElement>('.preset-heading > button')!.click(); await settle(fixture);
    expect(document.querySelector('.default-choice button[aria-label="Use this preset"]')?.getAttribute('aria-checked')).toBe('true');
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    if (!useDefault) {
      document.querySelector<HTMLButtonElement>('.default-choice button[aria-label="Keep current"]')!.click();
      await settle(fixture);
    }
    const name = document.querySelector<HTMLInputElement>('.preset-creator input')!;
    name.value = 'First preset'; name.dispatchEvent(new Event('input')); await settle(fixture);
    document.querySelector('.preset-creator')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(fixture);
    const defaultWrite = expect.objectContaining({ makeDefault: true, expectedDefaultRevision: before.revision });
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith('scope', expect.objectContaining({ action: expect.objectContaining({ type: 'save-preset', name: 'First preset' }) }));
    if (useDefault)
      expect(bridge.sessionChatCommand).toHaveBeenCalledWith('scope', expect.objectContaining({ action: defaultWrite }));
    else
      expect(bridge.sessionChatCommand).not.toHaveBeenCalledWith('scope', expect.objectContaining({ action: defaultWrite }));
    complete(); await settle(fixture);
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
      fixture.componentInstance.harnesses()[0]?.models[0]?.thinking,
    ).toEqual(["low", "high"]);
    root.querySelector<HTMLButtonElement>("ex-agent-picker > button")!.click();
    await settle(fixture);
    const options = document.querySelectorAll('.agent-settings [role="option"]');
    expect([...options].map((option) => option.textContent?.trim())).toEqual(["GPT"]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('.agent-settings [aria-label="Thinking level"]')).not.toBeNull();
  });
  it("offers only named models with their thinking levels in a fetched preset catalog", async () => {
    const { fixture, bridge } = setup([], { ...capabilities, presets: [], presetCatalogs: true });
    await settle(fixture);
    const flow = fixture.componentInstance.presetFlow;
    flow.openPresetCreator();
    const catalog = await flow.presetDraft()!.catalogProvider!("claude", new AbortController().signal);
    expect(bridge.sessionChatCatalog).toHaveBeenCalledWith("scope", expect.objectContaining({ provider: "claude" }));
    expect(catalog.harness.models).toEqual([
      { id: "sonnet", label: "Sonnet", thinking: ["low", "high"], supportsFastMode: false },
    ]);
    expect(catalog.initial.model).toBe("sonnet");
    expect(catalog.initial.thinking).toBe("high");
    expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
  });
  it("asks for a model when an older engine has not reported one", async () => {
    const { fixture, root } = setup();
    await settle(fixture);
    const trigger = root.querySelector<HTMLButtonElement>("ex-agent-picker > button")!;
    expect(trigger.textContent).toContain("Choose model");
    trigger.click();
    await settle(fixture);
    expect(document.querySelectorAll('.agent-settings [role="option"]')).toHaveLength(0);
    expect(document.querySelector(".agent-settings")?.textContent).toContain("No models reported yet");
  });
  for (const provider of ['codex', 'claude', 'pi', 'opencode', 'antigravity']) {
    it(`loads ${provider} models before its first conversation and refreshes without sending`, async () => {
      const { fixture, root, bridge } = setup([], { ...state, provider, presetCatalogs: true });
      await settle(fixture);
      expect(bridge.sessionChatCatalog).toHaveBeenCalledTimes(1);
      expect(bridge.sessionChatCatalog).toHaveBeenCalledWith('scope', expect.objectContaining({ provider, taskId: 1, sessionId: 2 }));
      root.querySelector<HTMLButtonElement>('ex-agent-picker > button')!.click();
      await settle(fixture);
      expect(document.querySelector('.agent-settings [role="option"]')?.textContent).toContain('Sonnet');
      if (provider === 'antigravity') {
        expect(document.querySelector('.agent-settings [role="option"]')?.getAttribute('aria-selected')).toBe('true');
        expect(fixture.componentInstance.agent()).toMatchObject({ model: 'sonnet', thinking: 'high' });
      }
      expect(document.querySelector('.agent-settings')?.textContent).not.toContain('No models reported yet');
      const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-settings button')).find(button => button.textContent?.includes('Refresh models'))!;
      refresh.click();
      await settle(fixture);
      expect(bridge.sessionChatCatalog).toHaveBeenLastCalledWith('scope', expect.objectContaining({ provider, refresh: true }));
      expect(bridge.sessionChatCommand).not.toHaveBeenCalled();
    });
  }
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
        surface.querySelector('[role="option"][aria-selected="true"]')
          ?.textContent,
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
  it("scopes per-model quota to the selected model and shows live context", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const quotaState = {
      ...state,
      provider: "antigravity",
      providers: [{ id: "antigravity", label: "Antigravity" }],
      providerLocked: true,
      model: "opus",
      models: [{ id: "opus", label: "Claude Opus" }, { id: "flash", label: "Gemini Flash" }],
      context: { tokens: 262144, limit: 1048576, percentage: 25 },
      modelQuota: {
        provider: "antigravity",
        tier: "Antigravity Starter Quota",
        updatedAt: new Date().toISOString(),
        models: [{ id: "opus", label: "Claude Opus", remainingPercentage: null, exhausted: true, resetsAt }],
      },
    };
    const { fixture, root, publish } = setup([], quotaState);
    await settle(fixture);
    expect(fixture.componentInstance.agent()).toMatchObject({
      context: 0.25,
      plan: { name: "Antigravity", tier: "Starter Quota", scope: "model", exhausted: true },
    });
    expect(fixture.componentInstance.models().find((model) => model.id === "opus")?.limit?.left).toBe(0);
    expect(fixture.componentInstance.models().find((model) => model.id === "flash")?.limit).toBeUndefined();
    expect(root.querySelector("ex-agent-plan-meter")?.getAttribute("aria-label")).toContain("Claude Opus quota used up");
    expect(root.querySelector("ex-agent-usage-notice")?.textContent).toContain("Choose another model");
    publish({ taskId: 1, sessionId: 2, cursor: "new", reset: false, items: [], events: [], before: null, state: { ...quotaState, model: "flash" } });
    fixture.componentInstance.store.refresh();
    await settle(fixture);
    expect(fixture.componentInstance.agent()?.plan).toBeUndefined();
    expect(root.querySelector("ex-agent-plan-meter")).toBeNull();
    expect(root.querySelector("ex-agent-usage-notice .notice")).toBeNull();
  });
  it("offers the reported Antigravity modes and disables changes during a turn", async () => {
    const antigravity = {
      ...state,
      provider: "antigravity",
      controls: { plan: true, reasoning: true, fast: false },
      permissionMode: "default",
      permissionModes: ["default", "accept-edits", "auto", "bypassPermissions"],
    };
    const { fixture, root, bridge, publish, complete } = setup([], antigravity);
    await settle(fixture);
    expect(root.querySelector('ex-mode-toggle')?.textContent).toContain('Plan');
    const trigger = root.querySelector<HTMLButtonElement>("ex-permission-picker > button")!;
    expect(trigger.textContent).toContain("Ask first");
    trigger.click();
    await settle(fixture);
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Agent permissions"] .choice')];
    expect(choices.map(choice => choice.querySelector("strong")?.textContent)).toEqual([
      "Ask first", "Accept edits", "Auto", "Full access",
    ]);
    choices[2]!.click();
    expect(bridge.sessionChatCommand).toHaveBeenCalledWith("scope", expect.objectContaining({
      action: { type: "permission-mode", mode: "auto" },
    }));
    publish({
      taskId: 1, sessionId: 2, cursor: "running", reset: false, items: [], events: [], before: null,
      state: { ...antigravity, permissionMode: "auto", phase: "running", canInterrupt: true },
    });
    complete();
    await settle(fixture);
    expect(trigger.textContent).toContain("Auto");
    expect(trigger.disabled).toBe(true);
  });
  it("uses Plan/Code independently of Antigravity Full access when Auto is unavailable", async () => {
    const antigravity: SessionChatState = {
      ...state,
      provider: "antigravity",
      controls: { plan: true, reasoning: true, fast: false },
      permissionMode: "default",
      permissionModes: ["default", "accept-edits", "bypassPermissions"],
    };
    const { fixture, root, bridge, publish, complete } = setup([], antigravity);
    await settle(fixture);
    const trigger = root.querySelector<HTMLButtonElement>("ex-permission-picker > button")!;
    trigger.click();
    await settle(fixture);
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Agent permissions"] .choice')];
    expect(choices.map(choice => choice.querySelector("strong")?.textContent)).toEqual([
      "Ask first", "Accept edits", "Full access",
    ]);
    choices[2]!.click();
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", expect.objectContaining({
      action: { type: "permission-mode", mode: "bypassPermissions" },
    }));
    publish({
      taskId: 1, sessionId: 2, cursor: "full-access", reset: false, items: [], events: [], before: null,
      state: { ...antigravity, permissionMode: "bypassPermissions" },
    });
    complete();
    await settle(fixture);
    expect(trigger.textContent).toContain("Full access");
    const plan = [...root.querySelectorAll<HTMLButtonElement>("ex-mode-toggle button")]
      .find(button => button.textContent?.includes("Plan"));
    expect(plan).toBeDefined();
    plan!.click();
    expect(bridge.sessionChatCommand).toHaveBeenLastCalledWith("scope", expect.objectContaining({
      action: { type: "plan", enabled: true },
    }));
    complete();
    await settle(fixture);
  });
});


it('places images between their surrounding messages and hides them with their work disclosures', async () => {
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 640; naturalHeight = 360; decode = async () => undefined; });
  const output: SessionChatItem = { ...item('generated', 'tool_result', 'Image attachment'), toolId: 'capture',
    media: [{ id: '0', path: 'chat-image-generated-0', caption: 'Waving robot', inline: true }] };
  const { fixture, root, bridge, publish } = setup([
    item('prompt', 'user', 'Draw a robot'),
    { ...item('capture', 'tool_use', ''), toolId: 'capture' },
    item('commentary', 'assistant', 'Rendering the robot.'),
    output,
    item('reply', 'assistant', 'Here is your robot.'),
  ]);
  await settle(fixture);
  expect(bridge.sessionChatMedia).toHaveBeenCalledTimes(1);
  const image = root.querySelector('ex-markdown-media img')!;
  const fold = image.closest('ex-fold')!;
  expect(image.getAttribute('src')).toContain('data:image/png;base64,');
  expect([...root.querySelectorAll('[data-work-step]')].map(row => row.getAttribute('data-work-step')))
    .toEqual(['capture', 'commentary', 'generated', 'reply']);
  expect(root.querySelector('.answer img')).toBeNull();
  expect(fold.hasAttribute('inert')).toBe(true);
  const work = root.querySelector<HTMLButtonElement>('button.work')!;
  work.click();
  await settle(fixture);
  expect(fold.hasAttribute('inert')).toBe(true);
  const group = root.querySelector<HTMLButtonElement>('[data-work-step="generated"] button.group')!;
  group.click();
  await settle(fixture);
  expect(fold.hasAttribute('inert')).toBe(false);
  group.click();
  await settle(fixture);
  expect(fold.hasAttribute('inert')).toBe(true);
  group.click();
  await settle(fixture);
  work.click();
  await settle(fixture);
  expect(fold.hasAttribute('inert')).toBe(true);
  expect(root.querySelector('.answer')?.textContent).toContain('Here is your robot.');
  expect(root.textContent).not.toContain('Read full tool output');
  expect(root.textContent).not.toContain("isn't in the workspace");
  publish({ taskId: 1, sessionId: 3, cursor: 'new', reset: true, before: null, items: [], events: [], state });
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 3 });
  await settle(fixture);
  expect(bridge.sessionChatMedia).toHaveBeenCalledTimes(1);
  expect(root.querySelector('ex-markdown-media')).toBeNull();
});
