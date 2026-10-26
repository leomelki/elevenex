import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../conversation.models";
import { SessionStartComponent } from "./session-start.component";

describe("SessionStart preset selection", () => {
  let fixture: ComponentFixture<SessionStartComponent>;
  let selections: string[];
  const presets: readonly AgentConfig[] = Array.from(
    { length: 9 },
    (_, index) => ({
      preset: `Preset ${index + 1}`,
      mark: "EX",
      harness: "example",
      model: `model-${index + 1}`,
    }),
  );

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionStartComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionStartComponent);
    fixture.componentRef.setInput("presets", presets);
    selections = [];
    fixture.componentInstance.presetSelected.subscribe((value) =>
      selections.push(value),
    );
    fixture.detectChanges();
  });

  function selectedLabel(): string | null {
    return (
      fixture.nativeElement
        .querySelector('button[aria-pressed="true"] .name')
        ?.textContent?.trim() ?? null
    );
  }

  it("limits shortcuts to the six presets shown on screen", () => {
    const sixth = new KeyboardEvent("keydown", {
      key: "6",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    fixture.nativeElement.dispatchEvent(sixth);
    fixture.detectChanges();
    expect(sixth.defaultPrevented).toBe(true);
    expect(selectedLabel()).toBe("Preset 6");
    for (const key of ["7", "8", "9"]) {
      const hidden = new KeyboardEvent("keydown", {
        key,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      fixture.nativeElement.dispatchEvent(hidden);
      expect(hidden.defaultPrevented).toBe(false);
    }
    expect(selections).toEqual(["Preset 6"]);
  });

  it("applies later owner selections after a local preset choice", () => {
    fixture.componentRef.setInput("value", "Preset 2");
    fixture.detectChanges();
    expect(selectedLabel()).toBe("Preset 2");
    const cards: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll("ex-preset-card button"),
    );
    cards[0]?.click();
    fixture.detectChanges();
    expect(selectedLabel()).toBe("Preset 1");
    expect(selections).toEqual(["Preset 1"]);
    fixture.componentRef.setInput("value", "Preset 3");
    fixture.detectChanges();
    expect(selectedLabel()).toBe("Preset 3");
    expect(selections).toEqual(["Preset 1"]);
  });
});
