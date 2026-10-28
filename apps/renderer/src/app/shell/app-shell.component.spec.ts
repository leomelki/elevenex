import { TestBed } from "@angular/core/testing";
import { AppShellComponent } from "./app-shell.component";

describe("Desktop region ownership", () => {
  it("uses the enclosing machine's title bar when embedded", () => {
    const fixture = TestBed.createComponent(AppShellComponent);
    fixture.componentRef.setInput("titleBar", false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("ex-title-bar")).toBeNull();
    expect(fixture.nativeElement.classList.contains("embedded")).toBe(true);
    expect(fixture.nativeElement.querySelector('nav[aria-label="Projects"]')).not.toBeNull();
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
