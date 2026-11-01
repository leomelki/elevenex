import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnNavComponent } from "./turn-nav.component";

function turns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    label: `Prompt ${index + 1}`,
  }));
}

describe("TurnNav", () => {
  let resized: () => void;
  let originalScrollTo: PropertyDescriptor | undefined;
  const disconnected = vi.fn();
  beforeEach(() => {
    disconnected.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(): void {}
        disconnect = disconnected;
      },
    );
    const originalHeight = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientHeight",
    )?.get;
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.classList.contains("markers")
          ? 168
          : (originalHeight?.call(this) ?? 0);
      },
    );
    originalScrollTo = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTo",
    );
    Object.defineProperty(Element.prototype, "scrollTo", {
      configurable: true,
      value: function (
        this: Element,
        options?: ScrollToOptions | number,
        y?: number,
      ) {
        this.scrollTop =
          typeof options === "number"
            ? (y ?? 0)
            : (options?.top ?? this.scrollTop);
        this.dispatchEvent(new Event("scroll"));
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalScrollTo)
      Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(Element.prototype, "scrollTo");
  });

  async function setup(count: number, active = "turn-0") {
    const fixture = TestBed.createComponent(TurnNavComponent);
    fixture.componentRef.setInput("turns", turns(count));
    fixture.componentRef.setInput("active", active);
    fixture.detectChanges();
    await fixture.whenStable();
    if (count) resized();
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    document.body.append(host);
    const viewport = host.querySelector<HTMLElement>(".markers");
    // CDK coalesces native scroll notifications on the animation-frame scheduler.
    await new Promise(requestAnimationFrame);
    fixture.detectChanges();
    await fixture.whenStable();
    const key = async (value: string) => {
      viewport?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
      fixture.detectChanges();
      await new Promise(requestAnimationFrame);
      await fixture.whenStable();
    };
    return { fixture, host, viewport, key };
  }

  it.each([1, 2, 4, 5])(
    "shows short sessions with %i targets",
    async (count) => {
      const { fixture, host } = await setup(count);
      const buttons = host.querySelectorAll<HTMLButtonElement>("button");
      expect(buttons).toHaveLength(count);
      expect(buttons[0]?.getAttribute("aria-current")).toBe("step");
      expect(buttons[0]?.getAttribute("aria-label")).toBe(
        `Message 1 of ${count} · Prompt 1`,
      );
      const selected = vi.fn();
      fixture.componentInstance.selected.subscribe(selected);
      buttons[count - 1]?.click();
      expect(selected).toHaveBeenCalledWith(`turn-${count - 1}`);
      fixture.destroy();
      host.remove();
    },
  );

  it("bounds rendered controls for thousands of turns and browses without jumping the chat", async () => {
    const { fixture, host, viewport, key } = await setup(10000, "turn-5000");
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    expect(host.querySelectorAll("button").length).toBeLessThan(30);
    expect(host.querySelector('[aria-current="step"]')).not.toBeNull();
    viewport?.focus();
    await key("End");
    await key("Enter");
    expect(selected).toHaveBeenCalledExactlyOnceWith("turn-9999");
    expect(document.activeElement).toBe(viewport);
    expect(host.querySelector(".position")?.textContent).toContain(
      "10000 / 10000",
    );
    const descendant = viewport?.getAttribute("aria-activedescendant");
    expect(
      descendant &&
        document.getElementById(descendant)?.getAttribute("aria-posinset"),
    ).toBe("10000");
    await key("Home");
    await key("ArrowDown");
    await key("PageDown");
    expect(selected).toHaveBeenCalledTimes(1);
    await key(" ");
    expect(selected).toHaveBeenLastCalledWith("turn-8");
    expect(host.querySelectorAll("button").length).toBeLessThan(30);
    fixture.destroy();
    host.remove();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("keeps targets stable during interaction and resumes following after leaving", async () => {
    const { fixture, host, viewport } = await setup(1000, "turn-500");
    const offset = viewport?.scrollTop;
    const nav = host.querySelector("nav")!;
    nav.dispatchEvent(new Event("pointerenter"));
    fixture.componentRef.setInput("active", "turn-900");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(viewport?.scrollTop).toBe(offset);
    nav.dispatchEvent(new Event("pointerleave"));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(viewport?.scrollTop).toBeGreaterThan(offset ?? 0);
    fixture.destroy();
    host.remove();
  });

  it("reconciles long, short and empty sessions and releases its observer", async () => {
    const { fixture, host, viewport } = await setup(1000, "turn-999");
    viewport?.focus();
    fixture.componentRef.setInput(
      "turns",
      turns(10000).map((turn) => ({ ...turn, id: `next-${turn.id}` })),
    );
    fixture.componentRef.setInput("active", "next-turn-5000");
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(requestAnimationFrame);
    await fixture.whenStable();
    expect(
      host
        .querySelector('[aria-current="step"]')
        ?.getAttribute("aria-posinset"),
    ).toBe("5001");
    expect(document.activeElement).toBe(viewport);
    fixture.componentRef.setInput("turns", [
      { id: "next", label: "New session" },
    ]);
    fixture.componentRef.setInput("active", "next");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    fixture.componentRef.setInput("turns", []);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector("nav")).toBeNull();
    expect(disconnected).toHaveBeenCalledOnce();
    fixture.destroy();
    host.remove();
  });
});
