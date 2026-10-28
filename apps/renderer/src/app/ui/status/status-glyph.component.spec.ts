import { TestBed } from "@angular/core/testing";
import { StatusGlyphComponent } from "./status-glyph.component";

describe("Status glyph changes", () => {
  const originalAnimate = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "animate",
  );
  const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
  const animate = vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
    animations.push(animation);
    return animation;
  });

  beforeEach(() => {
    animations.length = 0;
    animate.mockClear();
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => {
    if (originalAnimate)
      Object.defineProperty(Element.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(Element.prototype, "animate");
    vi.unstubAllGlobals();
  });

  it("leaves history still, draws a completed run once, and cancels motion when destroyed", async () => {
    const fixture = TestBed.createComponent(StatusGlyphComponent);
    fixture.componentRef.setInput("status", "done");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).not.toHaveBeenCalled();

    fixture.componentRef.setInput("status", "running");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).toHaveBeenCalledOnce();

    fixture.componentRef.setInput("status", "done");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animations[0]?.cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate).toHaveBeenLastCalledWith(
      [
        { strokeDasharray: "1", strokeDashoffset: "1" },
        { strokeDasharray: "1", strokeDashoffset: "0" },
      ],
      expect.any(Object),
    );

    fixture.componentRef.setInput("status", "done");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).toHaveBeenCalledTimes(3);
    fixture.destroy();
    expect(animations[1]?.cancel).toHaveBeenCalledOnce();
    expect(animations[2]?.cancel).toHaveBeenCalledOnce();
  });

  it("applies status changes without movement under reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const fixture = TestBed.createComponent(StatusGlyphComponent);
    fixture.componentRef.setInput("status", "running");
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentRef.setInput("status", "done");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector("svg").getAttribute("aria-label"),
    ).toBe("Done");
    expect(animate).not.toHaveBeenCalled();
  });

  it('settles an active status change when reduced motion is enabled and releases its listener', async () => {
    let changed = () => {};
    const removed = vi.fn();
    const media = { matches: false, addEventListener: (_event: string, listener: () => void) => { changed = listener; }, removeEventListener: removed };
    vi.stubGlobal('matchMedia', () => media);
    const fixture = TestBed.createComponent(StatusGlyphComponent);
    fixture.detectChanges(); await fixture.whenStable();
    fixture.componentRef.setInput('status', 'attention');
    fixture.detectChanges(); await fixture.whenStable();
    expect(animate).toHaveBeenCalledOnce();
    media.matches = true; changed();
    expect(animations[0]?.cancel).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('svg').getAttribute('aria-label')).toBe('Needs you');
    fixture.destroy();
    expect(removed).toHaveBeenCalledWith('change', changed);
  });
});
