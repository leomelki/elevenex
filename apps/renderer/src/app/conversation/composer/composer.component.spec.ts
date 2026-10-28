import { Component, signal, viewChild } from "@angular/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerSubmission } from "../conversation.models";
import { ComposerComponent } from "./composer.component";

describe("Composer public interactions", () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let sent: ComposerSubmission[];
  beforeEach(async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await TestBed.configureTestingModule({
      imports: [ComposerComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(ComposerComponent);
    sent = [];
    fixture.componentInstance.submitted.subscribe((value) => sent.push(value));
    fixture.detectChanges();
  });
  function type(text: string): HTMLTextAreaElement {
    const textarea = fixture.nativeElement.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement))
      throw new Error("Missing composer textarea");
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
    return textarea;
  }
  function press(
    textarea: HTMLTextAreaElement,
    options: KeyboardEventInit = {},
  ): void {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
    fixture.detectChanges();
  }
  it("sends, queues and steers with the correct intent and clears accepted drafts", () => {
    press(type("  Explain the retry policy  "));
    expect(sent[0]?.intent).toBe("send");
    expect(sent[0]?.text).toBe("Explain the retry policy");
    expect(fixture.componentInstance.draft()).toBe("");
    fixture.componentRef.setInput("running", true);
    fixture.detectChanges();
    press(type("Add tests"));
    press(type("Use a bounded delay"), { altKey: true });
    expect(sent.map((value) => value.intent)).toEqual([
      "send",
      "queue",
      "steer",
    ]);
  });
  it("keeps newlines and IME composition local, and prevents empty or disabled sends", () => {
    press(type("line one"), { shiftKey: true });
    press(type("composing"), { isComposing: true });
    press(type("  "));
    fixture.componentRef.setInput("disabled", true);
    fixture.detectChanges();
    press(type("cannot send"));
    expect(sent).toEqual([]);
  });
  it("toggles mode without moving focus and requests stop only while running", () => {
    const modes: string[] = [];
    let stopped = 0;
    fixture.componentInstance.modeChanged.subscribe((mode) => modes.push(mode));
    fixture.componentInstance.stop.subscribe(() => stopped++);
    const textarea = type("");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: ".", metaKey: true, bubbles: true }),
    );
    expect(modes).toEqual(["plan"]);
    expect(stopped).toBe(0);
    fixture.componentRef.setInput("running", true);
    fixture.detectChanges();
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(stopped).toBe(1);
  });
  it("hands focus from tools to the composer before inserting a mention at the caret", async () => {
    fixture.componentRef.setInput("mentionItems", [
      { id: "retry", kind: "file", label: "retry.ts" },
    ]);
    const textarea = type("Review then test");
    textarea.setSelectionRange(7, 7);
    const tools = fixture.nativeElement.querySelector(
      'button[aria-label="Attachments and tools"]',
    );
    if (!(tools instanceof HTMLButtonElement)) throw new Error("Missing tools");
    tools.focus();
    tools.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const menuButtons = Array.from(document.querySelectorAll("button"));
    const mention = menuButtons.find((button) =>
      button.textContent?.includes("Mention a session, task or file"),
    );
    if (!mention) throw new Error("Missing mention action");
    mention.focus();
    mention.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(textarea);
    expect(
      document.querySelector('section[aria-label="Attachments and tools"]'),
    ).toBeNull();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    press(textarea);
    expect(fixture.componentInstance.draft()).toBe(
      "Review @retry.ts then test",
    );
    expect(textarea.selectionStart).toBe("Review @retry.ts ".length);
    expect(sent).toEqual([]);
  });
  it("resets the active mention when filtering and exposes it to assistive technology", () => {
    fixture.componentRef.setInput("mentionItems", [
      { id: "retry", kind: "file", label: "retry.ts" },
      { id: "tests", kind: "file", label: "retry.spec.ts" },
    ]);
    const textarea = type("@");
    press(textarea, { key: "ArrowDown" });
    expect(
      document.querySelector('[role="option"][aria-selected="true"]')
        ?.textContent,
    ).toContain("retry.spec.ts");
    type("@retry.ts");
    const selected = document.querySelector(
      '[role="option"][aria-selected="true"]',
    );
    expect(selected?.textContent).toContain("retry.ts");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(selected?.id);
    press(textarea);
    expect(fixture.componentInstance.draft()).toBe("@retry.ts ");
  });
});

@Component({
  imports: [ComposerComponent],
  template: `<ex-composer [draft]="draft()" (draftChange)="draft.set($event)" [clearOnSubmit]="false" (submitted)="reject($event)" />`,
})
class ControlledComposer {
  readonly draft = signal('Retain this message');
  readonly composer = viewChild(ComposerComponent);
  reject(submission: ComposerSubmission): void {
    this.draft.set('');
    this.draft.set(submission.text);
  }
}
describe('controlled composer delivery', () => {
  it('lets the owner restore a rejected message without a child reset overtaking it', async () => {
    const fixture = TestBed.createComponent(ControlledComposer);
    fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.composer()?.send();
    fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.componentInstance.draft()).toBe('Retain this message');
    expect((fixture.nativeElement as HTMLElement).querySelector('textarea')?.value).toBe('Retain this message');
    fixture.destroy();
  });
});
