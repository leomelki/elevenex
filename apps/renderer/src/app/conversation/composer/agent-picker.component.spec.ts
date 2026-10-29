import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { By } from "@angular/platform-browser";
import { DropdownComponent } from "../../ui";
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
    const dropdowns = fixture.debugElement.queryAll(
      By.directive(DropdownComponent),
    );
    const model = dropdowns.find((d) => d.componentInstance.label() === "Model")
      ?.componentInstance as DropdownComponent;
    const thinking = dropdowns.find(
      (d) => d.componentInstance.label() === "Thinking level",
    )?.componentInstance as DropdownComponent;
    expect(model.value()).toBe("focused");
    expect(thinking.value()).toBe("High");
    expect(
      thinking.options().find((option) => option.id === "Low")?.disabled,
    ).toBe(true);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    thinking.changed.emit("Max");
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: "Max" }),
    );
    changed.mockClear();
    thinking.changed.emit("Low");
    expect(changed).not.toHaveBeenCalled();
    const modelTrigger = document.querySelector<HTMLButtonElement>(
      '.agent-settings button[aria-label^="Model:"]',
    );
    modelTrigger?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const option = document.querySelector<HTMLButtonElement>(
      'ex-dropdown-menu[aria-label="Model"] button',
    );
    expect(option).not.toBeNull();
    option?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.querySelector(".agent-settings")).not.toBeNull();
    expect(
      document.querySelector('ex-dropdown-menu[aria-label="Model"]'),
    ).toBeNull();
    fixture.componentRef.setInput("busy", true);
    fixture.detectChanges();
    model.changed.emit("quick");
    expect(changed).not.toHaveBeenCalled();
    expect(fixture.componentInstance.open()).toBe(true);
    fixture.componentRef.setInput("disabled", true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      document.querySelector('[role="dialog"][aria-label="Adjust agent"]'),
    ).toBeNull();
    fixture.destroy();
  });
});
