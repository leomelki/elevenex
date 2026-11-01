import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatScrollComponent } from "./chat-scroll.component";
import { MessageComponent } from "./message.component";
@Component({
  selector: "ex-scroll-test",
  imports: [ChatScrollComponent, MessageComponent],
  template:
    '<ex-chat-scroll [startAtEnd]="false"><ex-message role="user" messageId="first">Explain this behavior</ex-message><p>A long reply</p></ex-chat-scroll>',
})
class ScrollTestComponent {}

describe("ChatScroll resource ownership", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("disconnects owned observers and cancels scheduled work when the chat closes", async () => {
    const resizeDisconnectors: ReturnType<typeof vi.fn>[] = [];
    const mutationDisconnected = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly disconnect = vi.fn();
        constructor() {
          resizeDisconnectors.push(this.disconnect);
        }
        observe(): void {}
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe(): void {}
        disconnect(): void {
          mutationDisconnected();
        }
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await TestBed.configureTestingModule({
      imports: [ScrollTestComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScrollTestComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.destroy();
    expect(resizeDisconnectors.length).toBeGreaterThan(0);
    for (const disconnect of resizeDisconnectors)
      expect(disconnect).toHaveBeenCalledOnce();
    expect(mutationDisconnected).toHaveBeenCalledOnce();
  });
});

describe("ChatScroll return to bottom", () => {
  let reduced = false;
  const resizeCallbacks: (() => void)[] = [];

  beforeEach(() => {
    reduced = false;
    resizeCallbacks.length = 0;
    vi.stubGlobal("matchMedia", () => ({
      get matches() { return reduced; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
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
    await TestBed.configureTestingModule({ imports: [ChatScrollComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ChatScrollComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const viewport = fixture.componentInstance.viewport().nativeElement;
    const dimensions = { height: 1200, viewport: 400 };
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => dimensions.height },
      clientHeight: { get: () => dimensions.viewport },
    });
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;
    const moveTo = (top: number) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
      fixture.detectChanges();
    };
    moveTo(800);
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.return-button');
    const control: HTMLElement = fixture.nativeElement.querySelector('.return');
    return { fixture, viewport, dimensions, scrollTo, moveTo, button, control };
  }

  it("offers a return without new content and keeps it stable through smooth travel", async () => {
    const { fixture, viewport, scrollTo, moveTo, button, control } = await setup();
    expect(control.hasAttribute("inert")).toBe(true);
    moveTo(200);
    expect(control.hasAttribute("inert")).toBe(false);
    expect(button.textContent).toContain("Scroll to bottom");
    expect(fixture.componentInstance.unread()).toBe(false);

    button.focus();
    button.click();
    fixture.detectChanges();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "smooth" });
    expect(document.activeElement).toBe(viewport);
    expect(control.classList.contains("visible")).toBe(true);
    moveTo(500);
    expect(control.classList.contains("visible")).toBe(true);
    moveTo(800);
    expect(control.hasAttribute("inert")).toBe(true);
    expect(control.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(viewport);
  });

  it("preserves reading position on growth, clears unread at the end, and resumes following", async () => {
    const { fixture, viewport, dimensions, moveTo, control } = await setup();
    moveTo(200);
    dimensions.height = 1400;
    // Exercise the owned content observer rather than calling private measurement.
    for (const callback of resizeCallbacks) callback();
    await new Promise(requestAnimationFrame);
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(200);
    expect(fixture.componentInstance.unread()).toBe(true);
    expect(control.hasAttribute("inert")).toBe(false);
    moveTo(1000);
    expect(fixture.componentInstance.unread()).toBe(false);
    dimensions.height = 1600;
    for (const callback of resizeCallbacks) callback();
    await new Promise(requestAnimationFrame);
    expect(viewport.scrollTop).toBe(1600);
  });

  it("jumps directly with reduced motion and reconciles a viewport that no longer overflows", async () => {
    const { fixture, viewport, dimensions, scrollTo, moveTo, button, control } = await setup();
    moveTo(200);
    reduced = true;
    button.click();
    fixture.detectChanges();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(1200);
    expect(control.hasAttribute("inert")).toBe(true);
    moveTo(200);
    dimensions.viewport = 1200;
    for (const callback of resizeCallbacks) callback();
    await new Promise(requestAnimationFrame);
    fixture.detectChanges();
    expect(control.hasAttribute("inert")).toBe(true);
  });
});
