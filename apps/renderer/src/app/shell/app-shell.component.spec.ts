import { TestBed } from "@angular/core/testing";
import { AppShellComponent } from "./app-shell.component";

describe("Desktop region ownership", () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
  it('takes over a narrow main region instead of squeezing its content and returns Escape intent', () => {
    const remove = vi.fn();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: remove }));
    const fixture = TestBed.createComponent(AppShellComponent), closed = vi.fn();
    fixture.componentInstance.panelCloseRequested.subscribe(closed);
    fixture.componentRef.setInput('panelOpen', true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('main').hasAttribute('inert')).toBe(true);
    expect(fixture.nativeElement.classList.contains('wide-review')).toBe(true);
    fixture.nativeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledOnce(); fixture.destroy(); expect(remove).toHaveBeenCalledOnce();
  });
  it("uses the enclosing machine's title bar when embedded", () => {
    const fixture = TestBed.createComponent(AppShellComponent);
    fixture.componentRef.setInput("titleBar", false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("ex-title-bar")).toBeNull();
    expect(fixture.nativeElement.classList.contains("embedded")).toBe(true);
    expect(fixture.nativeElement.querySelector('nav[aria-label="Projects"]')).not.toBeNull();
  });

  it('preserves shell motion when projected content commits its layout', () => {
    const fixture = TestBed.createComponent(AppShellComponent); fixture.detectChanges();
    const scope: HTMLElement = fixture.nativeElement.querySelector('.workspace');
    const width = vi.fn(), opacity = vi.fn(), unrelated = vi.fn();
    for (const region of Array.from(scope.children)) Object.defineProperty(region,'getAnimations',{value:()=>[
      {transitionProperty:'width',finish:width},{transitionProperty:'opacity',finish:opacity},{transitionProperty:'color',finish:unrelated},
    ]});
    scope.dispatchEvent(new Event('panel-layout-commit'));
    expect(width).not.toHaveBeenCalled(); expect(opacity).not.toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled();
  });

  it("excludes the closed panel and the covered chat from keyboard navigation", () => {
    const fixture = TestBed.createComponent(AppShellComponent);
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector(".panel") as HTMLElement;
    const main = fixture.nativeElement.querySelector("main") as HTMLElement;
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(main.hasAttribute("inert")).toBe(false);
    fixture.componentRef.setInput("panelOpen", true);
    fixture.componentRef.setInput("wideReview", true);
    fixture.detectChanges();
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(main.hasAttribute("inert")).toBe(true);
    const exited = vi.fn();
    fixture.componentInstance.reviewExited.subscribe(exited);
    panel.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(exited).toHaveBeenCalledOnce();
  });
});
