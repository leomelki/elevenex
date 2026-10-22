import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { AutoHeightDirective } from "./auto-height.directive";

@Component({
  imports: [AutoHeightDirective],
  template: `<section
    exAutoHeight
    style="padding: 12px; border: 1px solid; --dur-base: 200ms; --ease-out: ease-out"
  >
    <div>Content</div>
  </section>`,
})
class HeightTestComponent {}

describe("AutoHeight box sizing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("includes padding and borders, continues from interrupted height, and releases the observer", async () => {
    let resized: (() => void) | undefined;
    const disconnected = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resized = () => callback([], this);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect = disconnected;
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    let contentHeight = 100;
    let displayedHeight = 126;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(
          0,
          0,
          200,
          this.tagName === "SECTION" ? displayedHeight : contentHeight,
        );
      },
    );
    const fixture = TestBed.createComponent(HeightTestComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const section: HTMLElement = fixture.nativeElement.querySelector("section");
    const cancelled = vi.fn();
    const animate = vi.fn(() => ({ cancel: cancelled, onfinish: null }));
    Object.defineProperty(section, "animate", { value: animate });

    contentHeight = 160;
    resized?.();
    expect(animate).toHaveBeenLastCalledWith(
      [
        { height: "126px", overflow: "clip", boxSizing: "border-box" },
        { height: "186px", overflow: "clip", boxSizing: "border-box" },
      ],
      { duration: 200, easing: "ease-out" },
    );

    displayedHeight = 150;
    contentHeight = 180;
    resized?.();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenLastCalledWith(
      [
        { height: "150px", overflow: "clip", boxSizing: "border-box" },
        { height: "206px", overflow: "clip", boxSizing: "border-box" },
      ],
      { duration: 200, easing: "ease-out" },
    );

    fixture.destroy();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
});
