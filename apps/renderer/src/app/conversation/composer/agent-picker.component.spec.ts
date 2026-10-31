import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPickerComponent } from "./agent-picker.component";
import type { AgentConfig } from "../conversation.models";

const agent: AgentConfig = {
  preset: "Deep work",
  mark: "Cl",
  harness: "claude",
  model: "opus",
  thinking: "High",
};
const harnesses = [
  {
    id: "claude",
    label: "Claude Code",
    mark: "Cl",
    models: [
      { id: "opus", label: "Opus 5.5", thinking: ["High", "Max"] },
      {
        id: "sonnet",
        label: "Sonnet 5.5",
        thinking: ["Low", "Medium", "High"],
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    mark: "Cx",
    models: [{ id: "gpt", label: "GPT", thinking: ["low", "high", "xhigh"] }],
  },
];
function button(selector: string): HTMLButtonElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`Missing button: ${selector}`);
  return element;
}
async function settle(
  fixture: ComponentFixture<AgentPickerComponent>,
): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}
async function setup(reduced = true) {
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  const fixture = TestBed.createComponent(AgentPickerComponent);
  fixture.componentRef.setInput("value", agent);
  fixture.componentRef.setInput("harnesses", harnesses);
  await settle(fixture);
  const trigger = (
    fixture.nativeElement as HTMLElement
  ).querySelector<HTMLButtonElement>(".trigger");
  if (!trigger) throw new Error("Missing agent trigger");
  return {
    fixture,
    trigger,
    open: async () => {
      trigger.focus();
      trigger.click();
      await settle(fixture);
    },
  };
}
function escape(target: HTMLElement): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    }),
  );
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentPicker controlled settings and focus", () => {
  it("uses the reference hierarchy and emits only supported segmented thinking choices", async () => {
    const { fixture, open } = await setup();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await open();
    expect(
      document.querySelector(".agent-settings .heading")?.textContent,
    ).toContain("Adjust “Deep work”");
    expect(
      document.querySelector(".agent-settings .harness")?.textContent,
    ).toContain("Claude Code");
    expect(
      button('.agent-settings [aria-label^="Model:"]').textContent,
    ).toContain("Opus 5.5");
    const thinking = '[aria-label="Thinking level"]';
    expect(
      button(`${thinking} button[aria-label="High"]`).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(button(`${thinking} button[aria-label="Low"]`).disabled).toBe(true);
    button(`${thinking} button[aria-label="Low"]`).click();
    expect(changed).not.toHaveBeenCalled();
    button(`${thinking} button[aria-label="Max"]`).click();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: "Max", preset: undefined }),
    );
    expect(fixture.componentInstance.value().thinking).toBe("High");
    expect(document.querySelector("footer")?.textContent).toContain(
      "Applies from the next message",
    );
  });
  it("dismisses a nested model menu before settings and restores the original focus", async () => {
    const { fixture, trigger, open } = await setup();
    await open();
    button('.agent-settings [aria-label^="Model:"]').click();
    await settle(fixture);
    const option = button('ex-dropdown-menu[aria-label="Model"] button');
    escape(option);
    await settle(fixture);
    expect(
      document.querySelector('ex-dropdown-menu[aria-label="Model"]'),
    ).toBeNull();
    expect(
      document.querySelector(".agent-settings")?.getAttribute("aria-hidden"),
    ).toBe("false");
    escape(button('.agent-settings [aria-label^="Model:"]'));
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("retains an inert exiting portal, restores focus immediately, and permits interrupted reopening", async () => {
    const { fixture, trigger, open } = await setup(false);
    await open();
    const surface = document.querySelector(".agent-settings");
    trigger.click();
    await settle(fixture);
    expect(surface?.hasAttribute("inert")).toBe(true);
    expect(surface?.getAttribute("aria-hidden")).toBe("true");
    const priorEntry = new Event("animationend", { bubbles: true });
    Object.defineProperty(priorEntry, "animationName", { value: "menu-enter" });
    surface?.dispatchEvent(priorEntry);
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBe(surface);
    expect(document.activeElement).toBe(trigger);
    fixture.componentRef.setInput("value", { ...agent, preset: "Another mix" });
    await settle(fixture);
    expect(surface?.querySelector(".heading")?.textContent).toContain(
      "Deep work",
    );
    trigger.click();
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBe(surface);
    expect(surface?.querySelector(".heading")?.textContent).toContain(
      "Another mix",
    );
    expect(surface?.hasAttribute("inert")).toBe(false);
    trigger.click();
    await settle(fixture);
    surface?.dispatchEvent(new Event("animationend", { bubbles: true }));
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBeNull();
    fixture.destroy();
  });
  it("keeps settings and focus available for successive harness and model choices", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("locked", false);
    fixture.componentRef.setInput("value", {
      ...agent,
      context: 0.84,
      tokens: "168k of 200k",
      plan: { win: 0.12 },
    });
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe((value) => {
      changed(value);
      fixture.componentRef.setInput("value", value);
    });
    await open();
    const surface = document.querySelector(".agent-settings");
    const codex = button('[aria-label="Harness"] button[aria-label="Codex"]');
    codex.focus();
    codex.click();
    await settle(fixture);
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "codex", model: "gpt", mark: "Cx" }),
    );
    expect(document.querySelector(".agent-settings")).toBe(surface);
    expect(document.activeElement).toBe(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(
      button('.agent-settings [aria-label^="Model:"]').textContent,
    ).toContain("GPT");
    expect(document.querySelector(".menu-usage")).toBeNull();
    button('[aria-label="Harness"] button[aria-label="Claude Code"]').click();
    await settle(fixture);
    button('.agent-settings [aria-label^="Model:"]').click();
    await settle(fixture);
    button('ex-dropdown-menu[aria-label="Model"] button:last-child').click();
    await settle(fixture);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ harness: "claude", model: "sonnet" }),
    );
    expect(document.querySelector(".agent-settings")).toBe(surface);
  });
  it("keeps the surface mounted during a save and disables every editable choice", async () => {
    const { fixture, open } = await setup();
    await open();
    const surface = document.querySelector(".agent-settings");
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentRef.setInput("busy", true);
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBe(surface);
    expect(button('.agent-settings [aria-label^="Model:"]').disabled).toBe(
      true,
    );
    expect(
      button('[aria-label="Thinking level"] button[aria-label="Max"]').disabled,
    ).toBe(true);
    expect(document.querySelector("footer")?.textContent).toContain(
      "Updating agent",
    );
    const heading = document.querySelector<HTMLElement>(
      ".agent-settings .heading",
    );
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      keyCode: 9,
      bubbles: true,
      cancelable: true,
    });
    heading?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(heading);
    button('[aria-label="Thinking level"] button[aria-label="Max"]').click();
    expect(changed).not.toHaveBeenCalled();
    fixture.componentRef.setInput("disabled", true);
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBeNull();
  });
  it.each(["Escape", "backdrop", "trigger", "owner"])(
    "keeps usage closed after dismissing settings via %s until a fresh hover or focus",
    async (dismissal) => {
      const { fixture, trigger, open } = await setup();
      fixture.componentRef.setInput("value", {
        ...agent,
        plan: { week: 0.58 },
      });
      const host = fixture.nativeElement as HTMLElement;
      host.dispatchEvent(new MouseEvent("mousemove"));
      await open();
      if (dismissal === "Escape")
        escape(button('.agent-settings [aria-label^="Model:"]'));
      else if (dismissal === "backdrop")
        document.querySelector<HTMLElement>(".cdk-overlay-backdrop")?.click();
      else if (dismissal === "trigger") trigger.click();
      else fixture.componentInstance.closePicker();
      await settle(fixture);
      expect(document.activeElement).toBe(trigger);
      // Uncovering the trigger can generate an enter without pointer movement.
      host.dispatchEvent(new MouseEvent("mouseenter"));
      await new Promise((resolve) => setTimeout(resolve, 420));
      await settle(fixture);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(trigger.hasAttribute("aria-describedby")).toBe(false);

      host.dispatchEvent(new MouseEvent("mouseleave"));
      host.dispatchEvent(new MouseEvent("mouseenter"));
      host.dispatchEvent(new MouseEvent("mousemove"));
      await settle(fixture);
      await new Promise((resolve) => setTimeout(resolve, 420));
      await settle(fixture);
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
      host.dispatchEvent(new MouseEvent("mouseleave"));
      await settle(fixture);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();

      trigger.blur();
      trigger.focus();
      await settle(fixture);
      await new Promise((resolve) => setTimeout(resolve, 420));
      await settle(fixture);
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    },
  );
  it("discloses usage after the focus delay and releases hover and portal resources on destruction", async () => {
    const { fixture, trigger } = await setup();
    // Usage can arrive after focus, without another pointer or focus event.
    trigger.focus();
    await settle(fixture);
    fixture.componentRef.setInput("value", {
      ...agent,
      context: 0.84,
      tokens: "168k of 200k",
      plan: {
        name: "Claude plan",
        tier: "Max",
        win: 0.12,
        week: 0.58,
        resetWin: "14:30",
        resetWeek: "Monday",
      },
    });
    await settle(fixture);
    trigger.focus();
    await settle(fixture);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 420));
    await settle(fixture);
    const card = document.querySelector('[role="tooltip"]');
    expect(card?.textContent).toContain("168k of 200k");
    expect(card?.textContent).toContain("12% left");
    expect(card?.textContent).toContain("Resets at 14:30");
    expect(card?.textContent).toContain("Resets Monday");
    expect(card?.querySelector("button")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBe(card?.id);
    trigger.click();
    await settle(fixture);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.querySelector(".menu-usage")?.textContent).toContain("84%");
    fixture.destroy();
    expect(document.querySelector(".agent-settings")).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
