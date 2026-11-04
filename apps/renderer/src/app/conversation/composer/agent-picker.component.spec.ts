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
const longHarness = {
  ...harnesses[0]!,
  models: [
    ...harnesses[0]!.models,
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`,
      label: index === 7 ? "Kimi K3" : `Model ${index}`,
      thinking: [],
    })),
  ],
};
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
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function option(label: string): HTMLButtonElement {
  return button(`.agent-settings [role="option"][data-label="${label}"]`);
}
function slider(): HTMLInputElement {
  const element = document.querySelector('[aria-label="Thinking level"]');
  if (!(element instanceof HTMLInputElement))
    throw new Error("Missing thinking slider");
  return element;
}
function commitLevel(index: number): void {
  const range = slider();
  range.value = String(index);
  range.dispatchEvent(new Event("input", { bubbles: true }));
  range.dispatchEvent(new Event("change", { bubbles: true }));
}
function key(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("AgentPicker controlled settings and focus", () => {
  it("shows the harness, its models and a thinking track, and emits a committed level", async () => {
    const { fixture, open } = await setup();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await open();
    const heading = document.querySelector(".agent-settings .heading");
    expect(heading?.textContent).toContain("Claude Code");
    expect(heading?.textContent).toContain("Deep work");
    expect(heading?.textContent).toContain("fixed for this conversation");
    // A locked harness has no rail: its models are the whole menu.
    expect(document.querySelector('[aria-label="Harness"]')).toBeNull();
    expect(option("Opus 5.5").getAttribute("aria-selected")).toBe("true");
    expect(option("Sonnet 5.5").getAttribute("aria-selected")).toBe("false");
    // jsdom has no geometry for CDK's focus check; captures verify real focus.
    expect(option("Opus 5.5").hasAttribute("cdkFocusInitial")).toBe(true);
    expect(slider().max).toBe("1");
    expect(slider().getAttribute("aria-valuetext")).toBe("High");
    expect(changed).not.toHaveBeenCalled();
    commitLevel(1);
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: "Max", preset: undefined }),
    );
    expect(fixture.componentInstance.value().thinking).toBe("High");
    // The mix already matches a preset, so there is nothing to save.
    expect(document.querySelector(".agent-settings .save")).toBeNull();
    expect(document.querySelector(".agent-settings footer")?.textContent).toContain(
      "Fork to",
    );
  });
  it.each([
    ["claude", ["low", "medium", "high", "xhigh", "max"]],
    [
      "codex",
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    ],
    ["pi", ["off", "minimal", "low", "medium", "high"]],
    ["opencode", ["low", "high", "custom-deep", "custom-fast"]],
  ] as const)(
    "preserves the %s model effort IDs and progression",
    async (harness, levels) => {
      const { fixture, open } = await setup();
      fixture.componentRef.setInput("harnesses", [
        {
          id: harness,
          label: harness,
          mark: "A",
          models: [{ id: "model", label: "Model", thinking: levels }],
        },
      ]);
      fixture.componentRef.setInput("value", {
        harness,
        mark: "A",
        model: "model",
        thinking: levels[0],
      });
      const changed = vi.fn();
      fixture.componentInstance.changed.subscribe(changed);
      await open();
      expect(slider().max).toBe(String(levels.length - 1));
      const labels: string[] = [];
      for (let index = 0; index < levels.length; index++) {
        slider().value = String(index);
        slider().dispatchEvent(new Event("input", { bubbles: true }));
        await settle(fixture);
        labels.push(slider().getAttribute("aria-valuetext") ?? "");
      }
      expect(labels).toEqual(
        levels.map((id) =>
          id === "xhigh" ? "Extra high" : id.charAt(0).toUpperCase() + id.slice(1),
        ),
      );
      // Dragging previews; only the committed level is emitted.
      expect(changed).not.toHaveBeenCalled();
      commitLevel(levels.length - 1);
      expect(changed).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledWith(
        expect.objectContaining({ thinking: levels.at(-1) }),
      );
    },
  );
  it("hides thinking when the selected model has no reported efforts", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("harnesses", [
      {
        id: "claude",
        label: "Claude",
        mark: "Cl",
        models: [{ id: "opus", label: "Unknown", thinking: [] }],
      },
    ]);
    fixture.componentRef.setInput("fastAvailable", false);
    await open();
    expect(document.querySelector('[aria-label="Thinking level"]')).toBeNull();
    expect(document.querySelector(".agent-settings .tune")).toBeNull();
  });
  it.each(["Home", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "PageDown"])(
    "selects the first reported thinking level from Default with %s",
    async (pressed) => {
      const { fixture, open } = await setup();
      fixture.componentRef.setInput("value", { ...agent, thinking: undefined });
      const changed = vi.fn();
      fixture.componentInstance.changed.subscribe(changed);
      await open();
      expect(slider().getAttribute("aria-valuetext")).toBe("Default");
      expect(key(slider(), pressed).defaultPrevented).toBe(true);
      await settle(fixture);
      expect(changed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ thinking: "High" }),
      );
      expect(slider().getAttribute("aria-valuetext")).toBe("High");
    },
  );
  it("commits an unchanged first thinking step on pointer release without duplicating native changes", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("value", { ...agent, thinking: undefined });
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await open();
    slider().dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ thinking: "High" }),
    );
    fixture.componentRef.setInput("value", { ...agent, thinking: undefined });
    // A disabled update re-syncs the local preview, just as an owner rejection does.
    fixture.componentRef.setInput("busy", true);
    await settle(fixture);
    slider().dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput("busy", false);
    await settle(fixture);
    commitLevel(1);
    slider().dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinking: "Max" }),
    );
  });
  it("moves through models with the keyboard and chooses only on a deliberate press", async () => {
    const { fixture, trigger, open } = await setup();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await open();
    key(option("Opus 5.5"), "ArrowDown");
    expect(document.activeElement).toBe(option("Sonnet 5.5"));
    key(option("Sonnet 5.5"), "Home");
    expect(document.activeElement).toBe(option("Opus 5.5"));
    key(option("Opus 5.5"), "s");
    expect(document.activeElement).toBe(option("Sonnet 5.5"));
    expect(changed).not.toHaveBeenCalled();
    option("Sonnet 5.5").click();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        thinking: "High",
        preset: undefined,
      }),
    );
    escape(option("Sonnet 5.5"));
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("closes on Escape pressed on the chip before focus reaches the menu", async () => {
    const { fixture, trigger, open } = await setup();
    await open();
    trigger.focus();
    escape(trigger);
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("filters a long model list, and Escape clears the filter before closing", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("harnesses", [longHarness]);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await open();
    key(option("Opus 5.5"), "k");
    await settle(fixture);
    const filter = document.querySelector<HTMLInputElement>(
      '.agent-settings input[aria-label="Filter models"]',
    );
    expect(document.activeElement).toBe(filter);
    expect(filter?.value).toBe("k");
    expect(
      [...document.querySelectorAll('.agent-settings [role="option"]')].map(
        (item) => item.getAttribute("data-label"),
      ),
    ).toEqual(["Kimi K3"]);
    key(filter!, "Enter");
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m7" }),
    );
    escape(filter!);
    await settle(fixture);
    expect(filter?.value).toBe("");
    expect(document.querySelector(".agent-settings")).not.toBeNull();
    escape(filter!);
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBeNull();
  });
  it("keeps search and focus through a catalog shrinking below the threshold, including clearing its query", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("harnesses", [longHarness, harnesses[1]!]);
    await open();
    const filter = document.querySelector<HTMLInputElement>('.filter input')!;
    filter.focus();
    filter.value = "Kimi";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(fixture);
    expect(document.querySelectorAll('.agent-settings [role="option"]')).toHaveLength(1);
    fixture.componentRef.setInput("harnesses", [
      { ...longHarness, models: longHarness.models.slice(0, 8) },
      harnesses[1]!,
    ]);
    await settle(fixture);
    expect(document.querySelector('.filter input')).toBe(filter);
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe("Kimi");
    expect(document.querySelectorAll('.agent-settings [role="option"]')).toHaveLength(0);
    escape(filter);
    await settle(fixture);
    expect(document.querySelector('.filter input')).toBe(filter);
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe("");
    expect(document.querySelectorAll('.agent-settings [role="option"]')).toHaveLength(8);
    fixture.componentRef.setInput("value", { ...agent, harness: "codex", model: "gpt" });
    await settle(fixture);
    expect(document.querySelector('.filter input')).toBeNull();
    fixture.componentRef.setInput("value", agent);
    await settle(fixture);
    expect(document.querySelector('.filter input')).toBeNull();
  });
  it("leaves Space available for native model activation in a searchable catalog", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("harnesses", [longHarness]);
    await open();
    const model = option("Sonnet 5.5");
    model.focus();
    expect(key(model, " ").defaultPrevented).toBe(false);
    await settle(fixture);
    expect(document.activeElement).toBe(model);
    expect(document.querySelector<HTMLInputElement>('.filter input')?.value).toBe("");
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
  it("keeps the menu and focus for successive harness and model choices", async () => {
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
    expect(surface?.querySelector(".plan")?.textContent).toContain("12% left");
    const rail = '[role="radiogroup"][aria-label="Harness"]';
    const codex = button(`${rail} [role="radio"][aria-label="Codex"]`);
    codex.focus();
    codex.click();
    await settle(fixture);
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "codex",
        model: "gpt",
        mark: "Cx",
        plan: undefined,
      }),
    );
    expect(document.querySelector(".agent-settings")).toBe(surface);
    expect(document.activeElement).toBe(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(option("GPT").getAttribute("aria-selected")).toBe("true");
    expect(surface?.querySelector(".plan")).toBeNull();
    // Arrow keys move through harnesses and select, as in any radio group.
    key(codex, "ArrowUp");
    await settle(fixture);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ harness: "claude", model: "opus" }),
    );
    expect(document.activeElement).toBe(
      button(`${rail} [role="radio"][aria-label="Claude Code"]`),
    );
    option("Sonnet 5.5").click();
    await settle(fixture);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ harness: "claude", model: "sonnet" }),
    );
    expect(document.querySelector(".agent-settings")).toBe(surface);
    // A manual mix no longer matches the preset and can be saved as one.
    const saved = vi.fn();
    fixture.componentInstance.savePreset.subscribe(saved);
    button(".agent-settings .save").click();
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ model: "sonnet" }),
    );
  });
  it("toggles fast mode and offers Compact only once context is filling up", async () => {
    const { fixture, open } = await setup();
    fixture.componentRef.setInput("canCompact", true);
    fixture.componentRef.setInput("value", { ...agent, context: 0.5 });
    const changed = vi.fn();
    const compact = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentInstance.compactRequested.subscribe(compact);
    await open();
    expect(document.querySelector(".agent-settings .compact")).toBeNull();
    const fast = button('.agent-settings [aria-label="Fast mode"]');
    expect(fast.getAttribute("aria-pressed")).toBe("false");
    fast.click();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ fast: true, preset: undefined }),
    );
    fixture.componentRef.setInput("value", { ...agent, context: 0.93 });
    await settle(fixture);
    expect(
      document.querySelector(".agent-settings .context")?.getAttribute(
        "data-tone",
      ),
    ).toBe("danger");
    button(".agent-settings .compact").click();
    expect(compact).toHaveBeenCalledOnce();
    expect(document.activeElement?.matches(".agent-settings .heading")).toBe(
      true,
    );
  });
  it("keeps the surface and focus during an update and ignores every choice", async () => {
    const { fixture, open } = await setup();
    await open();
    const surface = document.querySelector(".agent-settings");
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentRef.setInput("busy", true);
    await settle(fixture);
    expect(document.querySelector(".agent-settings")).toBe(surface);
    // Model rows stay focusable so keyboard position survives the update;
    // a fresh focus request lands on the stable heading instead.
    expect(option("Sonnet 5.5").disabled).toBe(false);
    expect(option("Sonnet 5.5").getAttribute("aria-disabled")).toBe("true");
    expect(
      surface?.querySelector("[cdkFocusInitial]")?.matches(".heading"),
    ).toBe(true);
    option("Sonnet 5.5").click();
    expect(slider().disabled).toBe(true);
    expect(button('.agent-settings [aria-label="Fast mode"]').disabled).toBe(
      true,
    );
    expect(surface?.querySelector('[role="status"]')?.textContent).toContain(
      "Updating",
    );
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
        escape(option("Opus 5.5"));
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
    expect(document.querySelector(".agent-settings .plan")?.textContent).toContain(
      "12% left",
    );
    fixture.destroy();
    expect(document.querySelector(".agent-settings")).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
