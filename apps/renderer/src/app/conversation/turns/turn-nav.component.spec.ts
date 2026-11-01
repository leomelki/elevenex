import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { TurnNavComponent } from "./turn-nav.component";

describe("TurnNav", () => {
  it.each([1, 2, 4, 5, 8])("shows all %i turns and selects a message", (count) => {
    const fixture = TestBed.createComponent(TurnNavComponent);
    const turns = Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      label: `Prompt ${index + 1}`,
    }));
    fixture.componentRef.setInput("turns", turns);
    fixture.componentRef.setInput("active", "turn-0");
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const buttons = host.querySelectorAll<HTMLButtonElement>("nav button");
    expect(buttons).toHaveLength(count);
    expect(buttons[0]?.getAttribute("aria-current")).toBe("step");
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Prompt 1");
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    buttons[count - 1]?.click();
    expect(selected).toHaveBeenCalledWith(`turn-${count - 1}`);
    fixture.destroy();
  });

  it("updates navigation when switching between long, short and empty sessions", () => {
    const fixture = TestBed.createComponent(TurnNavComponent);
    const host: HTMLElement = fixture.nativeElement;
    for (const count of [8, 1, 0, 2]) {
      fixture.componentRef.setInput("turns", Array.from({ length: count }, (_, index) => ({
        id: `session-${count}-turn-${index}`,
        label: `Session ${count}, prompt ${index + 1}`,
      })));
      fixture.detectChanges();
      expect(host.querySelectorAll("nav button")).toHaveLength(count);
      expect(host.querySelector("nav") !== null).toBe(count > 0);
    }
    fixture.destroy();
  });
});
