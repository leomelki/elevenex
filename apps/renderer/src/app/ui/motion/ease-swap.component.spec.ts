import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EaseSwapComponent } from "./ease-swap.component";

@Component({
  imports: [EaseSwapComponent],
  template: `<button><ex-ease-swap [value]="label()" /></button>`,
})
class ActionHost {
  readonly label = signal("Next");
}

describe("inline action swaps", () => {
  const animateDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (animateDescriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "animate",
        animateDescriptor,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });
  it("renders and updates when media queries are unavailable", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const fixture = TestBed.createComponent(ActionHost);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.label.set("Create task");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toBe("Create task");
    fixture.destroy();
  });
  it("keeps the native action mounted, retargets the painted width and settles reduced motion", async () => {
    let resize: () => void = () => undefined;
    let reduced: () => void = () => undefined;
    const disconnected = vi.fn(),
      removed = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {
          /* card text only */
        }
        disconnect = disconnected;
      },
    );
    const media = {
      matches: false,
      addEventListener: (_event: string, callback: () => void) => {
        reduced = callback;
      },
      removeEventListener: removed,
    };
    vi.stubGlobal("matchMedia", () => media);
    let paintedWidth = 40;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(
          0,
          0,
          this.tagName === "EX-EASE-SWAP"
            ? paintedWidth
            : (this.textContent?.length ?? 0) * 10,
          18,
        );
      },
    );
    const animations: {
      cancel: ReturnType<typeof vi.fn>;
      onfinish: (() => void) | null;
      oncancel: (() => void) | null;
    }[] = [];
    const animate = vi.fn((frames: Keyframe[]) => {
      expect(frames.length).toBeGreaterThan(0);
      const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const fixture = TestBed.createComponent(ActionHost);
    fixture.detectChanges();
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      "button",
    ) as HTMLButtonElement;
    expect(animate).not.toHaveBeenCalled();
    fixture.componentInstance.label.set("Create task");
    fixture.detectChanges();
    await fixture.whenStable();
    resize();
    expect(fixture.nativeElement.querySelector("button")).toBe(button);
    const widthCalls = () =>
      animate.mock.calls.filter(
        (call) => !!call[0][0] && "width" in call[0][0],
      );
    expect(widthCalls().at(-1)?.[0]).toEqual([
      { width: "40px" },
      { width: "110px" },
    ]);
    paintedWidth = 72;
    fixture.componentInstance.label.set("Next");
    fixture.detectChanges();
    await fixture.whenStable();
    resize();
    expect(widthCalls().at(-1)?.[0]).toEqual([
      { width: "72px" },
      { width: "40px" },
    ]);
    media.matches = true;
    reduced();
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length > 0),
    ).toBe(true);
    fixture.destroy();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
