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
});
