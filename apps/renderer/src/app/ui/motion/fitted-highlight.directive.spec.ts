import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FittedHighlightDirective } from "./fitted-highlight.directive";

@Component({
  imports: [FittedHighlightDirective],
  template: `<div
    exFittedHighlight='[aria-selected="true"]'
    [highlightKey]="selection()"
  >
    <button [attr.aria-selected]="selection() === 0">First</button
    ><button [attr.aria-selected]="selection() === 1">Second</button>
  </div>`,
})
class HighlightHost {
  readonly selection = signal(0);
}

describe("fitted picker highlight", () => {
  const animateDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    if (animateDescriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "animate",
        animateDescriptor,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });
  it("glides a changed selection, fits a resized row immediately, and releases its observer", async () => {
    const disconnect = vi.fn();
    let resize: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {
          /* owned elements only */
        }
        unobserve() {
          /* old selection */
        }
        disconnect = disconnect;
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel, onfinish: null }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const fixture = TestBed.createComponent(HighlightHost);
    fixture.detectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement.querySelector("div") as HTMLElement;
    const buttons = root.querySelectorAll("button");
    let width = 90;
    for (const [index, button] of buttons.entries()) {
      Object.defineProperties(button, {
        offsetTop: { get: () => index * 32 },
        offsetLeft: { get: () => 0 },
        offsetWidth: { get: () => width },
        offsetHeight: { get: () => 30 },
      });
    }
    resize();
    const thumb = root.querySelector(".ex-fitted-highlight") as HTMLElement;
    expect(thumb.style.width).toBe("90px");
    expect(animate).not.toHaveBeenCalled();
    fixture.componentInstance.selection.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).toHaveBeenCalledOnce();
    expect(thumb.style.transform).toBe("translate(0px, 32px)");
    resize();
    expect(cancel).not.toHaveBeenCalled();
    width = 140;
    resize();
    expect(cancel).toHaveBeenCalledOnce();
    expect(thumb.style.width).toBe("140px");
    expect(animate).toHaveBeenCalledOnce();
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(root.querySelector(".ex-fitted-highlight")).toBeNull();
  });
});
