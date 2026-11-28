import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { TickerComponent } from "./ticker.component";

describe("live count motion", () => {
  it("renders initial history without motion and replaces each live value once", async () => {
    const fixture = TestBed.createComponent(TickerComponent);
    fixture.componentRef.setInput("value", 4);
    fixture.detectChanges();
    await fixture.whenStable();
    const first = fixture.nativeElement.querySelector("span") as HTMLElement;
    expect(first.textContent).toBe("4");
    expect(first.classList.contains("up")).toBe(false);
    expect(first.classList.contains("down")).toBe(false);
    fixture.componentRef.setInput("value", 5);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll("span")).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toBe("5");
    fixture.componentRef.setInput("value", 2);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toBe("2");
    expect(fixture.nativeElement.querySelectorAll("span")).toHaveLength(1);
    fixture.destroy();
  });
});
