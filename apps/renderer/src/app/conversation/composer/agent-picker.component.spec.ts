import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPickerComponent } from "./agent-picker.component";

describe("Agent capabilities", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it("shows the supplied model and thinking on first open and emits only supported choices", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const fixture = TestBed.createComponent(AgentPickerComponent);
    fixture.componentRef.setInput("value", {
      mark: "CX",
      harness: "codex",
      model: "focused",
      thinking: "High",
    });
    fixture.componentRef.setInput("harnesses", [
      {
        id: "codex",
        label: "Codex",
        mark: "CX",
        models: [
          { id: "quick", label: "Quick", thinking: ["Low"] },
          { id: "focused", label: "Focused", thinking: ["High", "Max"] },
        ],
      },
    ]);
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector("button") as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    const model = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent model"]',
    );
    const thinking = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Thinking level"]',
    );
    expect(model?.value).toBe("focused");
    expect(thinking?.value).toBe("High");
    expect(
      thinking?.querySelector<HTMLOptionElement>('option[value="Low"]')
        ?.disabled,
    ).toBe(true);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    if (!thinking) throw new Error("Missing thinking control");
    thinking.value = "Max";
    thinking.dispatchEvent(new Event("change", { bubbles: true }));
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: "Max" }),
    );
  });
});
