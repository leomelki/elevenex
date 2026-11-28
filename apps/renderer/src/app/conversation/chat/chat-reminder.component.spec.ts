import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatScrollComponent } from "./chat-scroll.component";
import { MessageComponent } from "./message.component";

@Component({
  imports: [ChatScrollComponent, MessageComponent],
  template: `<ex-chat-scroll [startAtEnd]="false" [reminder]="enabled()" [historyLoading]="loading()" [historyError]="error()">
    <ex-message role="user" messageId="first">Explain the retry policy</ex-message>
    <p>A long answer</p>
    <ex-message role="user" messageId="second">Check cancellation too</ex-message>
    <p class="tail">Another long answer</p>
  </ex-chat-scroll>`,
})
class ReminderTestComponent {
  readonly enabled = signal(true);
  readonly loading = signal(false);
  readonly error = signal("");
}

describe("ChatScroll contextual reminder", () => {
  const resizeCallbacks: (() => void)[] = [];
  beforeEach(() => {
    resizeCallbacks.length = 0;
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this));
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const fixture = TestBed.createComponent(ReminderTestComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const viewport = element.querySelector<HTMLDivElement>(".viewport")!;
    const messages = element.querySelectorAll<HTMLElement>("[data-user-message]");
    const dimensions = { height: 800, promptHeight: 100, next: 3000 };
    Object.defineProperties(viewport, {
      clientHeight: { get: () => dimensions.height },
      scrollHeight: { value: 8000 },
    });
    const rect = (offset: number, height: number) => new DOMRect(0, 100 + offset - viewport.scrollTop, 600, height);
    viewport.getBoundingClientRect = () => new DOMRect(0, 100, 600, dimensions.height);
    messages[0]!.getBoundingClientRect = () => rect(0, dimensions.promptHeight);
    messages[1]!.getBoundingClientRect = () => rect(dimensions.next, 100);
    viewport.scrollTo = vi.fn();
    const settle = async () => {
      await new Promise(requestAnimationFrame);
      fixture.detectChanges();
      await fixture.whenStable();
    };
    const moveTo = async (offset: number) => {
      viewport.scrollTop = offset;
      viewport.dispatchEvent(new Event("scroll"));
      await settle();
    };
    const resize = async () => {
      for (const callback of resizeCallbacks) callback();
      await settle();
    };
    const reminder = () => element.querySelector<HTMLElement>(".reminder");
    return { fixture, viewport, dimensions, moveTo, resize, reminder, settle };
  }

  it("waits until well past the prompt, tolerates small reversals, and hides near the prompt", async () => {
    const { moveTo, reminder } = await setup();
    for (const offset of [50, 101, 150, 195]) {
      await moveTo(offset);
      expect(reminder()).toBeNull();
    }
    await moveTo(200);
    expect(reminder()?.textContent).toContain("Explain the retry policy");
    await moveTo(180);
    expect(reminder()).not.toBeNull();
    await moveTo(170);
    expect(reminder()).toBeNull();
    await moveTo(180);
    expect(reminder()).toBeNull();
  });

  it("scales the margin with available height and suppresses cramped viewports", async () => {
    const { dimensions, moveTo, resize, reminder } = await setup();
    dimensions.height = 400;
    await moveTo(145);
    expect(reminder()).toBeNull();
    await moveTo(150);
    expect(reminder()).not.toBeNull();
    dimensions.height = 200;
    await resize();
    expect(reminder()).toBeNull();
    dimensions.height = 1600;
    await moveTo(195);
    expect(reminder()).toBeNull();
    await moveTo(200);
    expect(reminder()).not.toBeNull();
  });

  it("keeps context until the next prompt reaches the upper reading area", async () => {
    const { moveTo, reminder } = await setup();
    await moveTo(2100);
    expect(reminder()).not.toBeNull();
    await moveTo(2201);
    expect(reminder()?.textContent).toContain("Explain the retry policy");
    await moveTo(2830);
    expect(reminder()?.textContent).toContain("Explain the retry policy");
    await moveTo(2841);
    expect(reminder()).toBeNull();
    await moveTo(3101);
    expect(reminder()).toBeNull();
    await moveTo(3200);
    expect(reminder()?.textContent).toContain("Check cancellation too");
  });

  it("waits until an entire long prompt is outside the reading buffer", async () => {
    const { dimensions, moveTo, reminder } = await setup();
    dimensions.promptHeight = 1200;
    await moveTo(1150);
    expect(reminder()).toBeNull();
    await moveTo(1201);
    expect(reminder()).toBeNull();
    await moveTo(1296);
    expect(reminder()).not.toBeNull();
  });

  it("retains reminder identity and focus through background loading and failure", async () => {
    const { fixture, viewport, moveTo, reminder, settle } = await setup();
    await moveTo(400);
    const surface = reminder()!.querySelector<HTMLButtonElement>('.surface')!;
    surface.focus();
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges(); await settle();
    expect(reminder()!.querySelector('.surface')).toBe(surface);
    expect(document.activeElement).toBe(surface);
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.error.set("History unavailable");
    fixture.detectChanges(); await settle();
    expect(reminder()!.querySelector('.surface')).toBe(surface);
    expect(document.activeElement).toBe(surface);
    fixture.componentInstance.enabled.set(false);
    fixture.detectChanges(); await settle();
    expect(reminder()).toBeNull();
    expect(document.activeElement).toBe(viewport);
  });

  it("jumps back as one control and returns focus to the transcript when it leaves", async () => {
    const { viewport, moveTo, reminder } = await setup();
    await moveTo(3400);
    const surface = reminder()!.querySelector<HTMLButtonElement>(".surface")!;
    expect(reminder()!.querySelectorAll("button")).toHaveLength(1);
    expect(surface.getAttribute("aria-label")).toBe("Back to your message: Check cancellation too");
    surface.focus();
    surface.click();
    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 2976, behavior: "instant" });
    await moveTo(3000);
    expect(reminder()).toBeNull();
    expect(document.activeElement).toBe(viewport);
  });

  it("charges while a mouse rests on a clipped prompt, then opens; touch and fitting prompts never do", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { fixture, moveTo, reminder, settle } = await setup();
    await moveTo(400);
    const surface = reminder()!.querySelector<HTMLButtonElement>(".surface")!;
    const hover = (pointerType: string) => surface.dispatchEvent(new PointerEvent("pointerenter", { pointerType }));
    const wait = async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      fixture.detectChanges();
    };
    // jsdom has no layout: a fitting prompt reports no clipped overflow.
    hover("mouse");
    await settle();
    expect(reminder()!.classList).not.toContain("arming");
    const quote = reminder()!.querySelector<HTMLElement>(".quote")!;
    Object.defineProperties(quote, { scrollHeight: { value: 54 }, clientHeight: { value: 18 } });
    hover("touch");
    await wait();
    expect(reminder()!.className).not.toMatch(/arming|peek/);
    hover("mouse");
    await settle();
    expect(reminder()!.classList).toContain("arming");
    expect(reminder()!.classList).not.toContain("peek");
    await wait();
    expect(reminder()!.classList).toContain("peek");
    expect(reminder()!.classList).not.toContain("arming");
    expect(surface.getAttribute("aria-expanded")).toBe("true");
    surface.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    fixture.detectChanges();
    expect(reminder()!.className).not.toMatch(/arming|peek/);
    // Leaving during the charge drains it without opening.
    hover("mouse");
    await settle();
    surface.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await wait();
    expect(reminder()!.className).not.toMatch(/arming|peek/);
  });
});
