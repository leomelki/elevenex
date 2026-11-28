import { OverlayContainer } from "@angular/cdk/overlay";
import { TestBed } from "@angular/core/testing";
import type {
  BackendResult,
  SessionChatChangesPage,
  SessionChatChangesRead,
} from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { SessionChatReviewComponent } from "./session-chat-review.component";

beforeEach(() => {
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
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});
const reply = (input: SessionChatChangesRead): SessionChatChangesPage => ({
  turnId: input.turnId,
  revision: "a".repeat(64),
  offset: 0,
  total: 1,
  files: [{ path: "test.txt", status: "A", add: 1, del: 0 }],
  nextOffset: null,
  content: input.path
    ? {
        path: input.path,
        nextOffset: null,
        lines: [
          {
            id: "line",
            kind: "add",
            newNumber: 1,
            text: "<script>plain text</script>",
          },
        ],
      }
    : null,
});

describe("selected reply review ownership", () => {
  it("keeps previous-page controls on the file whose lines were paged", async () => {
    const client = { changes: vi.fn(async (_scope: string, input: SessionChatChangesRead) => {
      const offset = input.lineOffset ?? 0;
      return { ok: true as const, value: { ...reply(input), content: { path: 'test.txt', nextOffset: offset ? null : 400,
        lines: Array.from({ length: offset ? 1 : 400 }, (_, index) => ({ id: `line-${offset + index}`, kind: 'context' as const, newNumber: offset + index + 1, text: `Line ${offset + index + 1}` })) } } };
    }), cancel: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: client }] });
    const fixture = TestBed.createComponent(SessionChatReviewComponent);
    fixture.componentRef.setInput('target', { scopeId: 'scope', taskId: 1, sessionId: 2, turnId: 'reply', path: 'test.txt' });
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    fixture.componentInstance.request({ fileId: 'test.txt', rev: 'a'.repeat(64), mode: 'changes', reason: 'more' });
    await fixture.whenStable(); fixture.detectChanges();
    const previous = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('ex-diff-file .load button');
    expect(previous?.textContent).toContain('Previous lines');
    previous!.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(client.changes.mock.calls.at(-1)?.[1].lineOffset).toBe(0);
    expect(fixture.componentInstance.contents()[0]?.hasPreviousLines).toBe(false);
  });

  it("cancels exact request IDs on navigation, ignores stale replies and releases reads on destruction", async () => {
    const pending: {
      input: SessionChatChangesRead;
      resolve: (value: BackendResult<SessionChatChangesPage>) => void;
    }[] = [];
    const client = {
      changes: vi.fn(
        (_scope: string, input: SessionChatChangesRead) =>
          new Promise<BackendResult<SessionChatChangesPage>>((resolve) =>
            pending.push({ input, resolve }),
          ),
      ),
      cancel: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: SessionChatClient, useValue: client }],
    });
    const fixture = TestBed.createComponent(SessionChatReviewComponent);
    const target = {
      scopeId: "scope",
      taskId: 1,
      sessionId: 2,
      turnId: "old",
      path: "test.txt",
    };
    fixture.componentRef.setInput("target", target);
    fixture.detectChanges();
    fixture.componentRef.setInput("target", {
      ...target,
      sessionId: 3,
      turnId: "current",
    });
    fixture.detectChanges();
    expect(client.cancel).toHaveBeenCalledWith(
      "scope",
      pending[0]!.input.requestId,
    );
    pending[0]!.resolve({ ok: true, value: reply(pending[0]!.input) });
    await fixture.whenStable();
    expect(fixture.componentInstance.page()).toBeNull();
    pending[1]!.resolve({ ok: true, value: reply(pending[1]!.input) });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.page()?.turnId).toBe("current");
    expect(
      (fixture.nativeElement as HTMLElement).querySelector("script"),
    ).toBeNull();
    fixture.componentInstance.request({
      fileId: "test.txt",
      rev: "a".repeat(64),
      mode: "changes",
      reason: "retry",
    });
    const request = pending.at(-1)!.input;
    fixture.destroy();
    expect(client.cancel).toHaveBeenCalledWith("scope", request.requestId);
  });

  it('opens provider edits and shell observations from an empty net diff', async () => {
    const changes = vi.fn(async (_scope: string, input: SessionChatChangesRead): Promise<BackendResult<SessionChatChangesPage>> => {
      const source = input.source ?? 'net';
      const files = source === 'net' ? [] : [{ path: 'same.txt', status: 'M' as const, add: 401, del: 0 }];
      return { ok: true, value: {
        source, sources: ['provider', 'command'], files, total: files.length,
        turnId: input.turnId, revision: (source === 'provider' ? 'b' : 'c').repeat(64), offset: 0, nextOffset: null,
        ...(source === 'command' ? { notice: 'Observed during the command. Other writers may be included.' } : {}),
        content: input.path ? { path: input.path, nextOffset: null, lines: [{
          id: '1', kind: 'add', newNumber: 1, text: source === 'provider' ? 'provider change' : 'shell change',
          evidence: source === 'provider' ? 'Apply patch · patch' : 'Bash · command',
        }] } : null,
      } };
    });
    TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: { changes, cancel: vi.fn() } }] });
    const fixture = TestBed.createComponent(SessionChatReviewComponent);
    fixture.componentRef.setInput('target', { scopeId: 'scope', taskId: 1, sessionId: 2, turnId: 'reply' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    expect(changes.mock.calls[0]?.[1].source).toBe('net');
    expect(host.textContent).toContain('No changes');

    for (const [source, label, heading, line] of [
      ['provider', 'Provider edits', 'Apply patch · patch', 'provider change'],
      ['command', 'Command observations', 'Bash · command', 'shell change'],
    ] as const) {
      const trigger = host.querySelector<HTMLButtonElement>('ex-dropdown button')!;
      trigger.focus();
      trigger.click();
      fixture.detectChanges();
      await fixture.whenStable();
      const choice = [...overlay.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find(item => item.textContent?.includes(label));
      expect(choice).toBeTruthy();
      choice!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(changes.mock.calls.at(-1)?.[1]).toMatchObject({ source, offset: 0 });
      expect(document.activeElement).toBe(trigger);

      host.querySelector<HTMLButtonElement>('ex-diff-file .load button')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(changes.mock.calls.at(-1)?.[1]).toMatchObject({ source, path: 'same.txt', lineOffset: 0 });
      expect(host.textContent).toContain(heading);
      expect(host.textContent).toContain(line);
    }
    expect(host.textContent).toContain('Other writers may be included.');
  });
});
