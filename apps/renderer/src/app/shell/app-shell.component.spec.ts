import { TestBed } from "@angular/core/testing";
import { AppShellComponent } from "./app-shell.component";

describe("Desktop region ownership", () => {
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
