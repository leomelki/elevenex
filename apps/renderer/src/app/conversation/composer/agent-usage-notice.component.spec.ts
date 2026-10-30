import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AgentUsageNoticeComponent } from "./agent-usage-notice.component";
import { AgentPlanMeterComponent } from "./agent-plan-meter.component";
import { AgentUsageComponent } from "./agent-usage.component";

afterEach(() => TestBed.resetTestingModule());
describe("quota guidance", () => {
  it("dismisses low allowance, keeps higher urgency visible and clears when replenished", () => {
    const fixture = TestBed.createComponent(AgentUsageNoticeComponent);
    const root = fixture.nativeElement as HTMLElement;
    const agent = {
      mark: "Cx",
      harness: "codex",
      model: "gpt",
      context: 0.8,
      plan: { name: "Codex plan", win: 0.12, resetWin: "14:30" },
    };
    fixture.componentRef.setInput("agent", agent);
    fixture.detectChanges();
    expect(root.textContent).toContain("12% of your 5-hour limit left");
    root.querySelector<HTMLButtonElement>("button")!.click();
    fixture.detectChanges();
    expect(root.querySelector(".notice:not(.notice-leave)")).toBeNull();
    expect(root.querySelector("[exAutoHeight]")?.hasAttribute("inert")).toBe(true);
    fixture.componentRef.setInput("agent", { ...agent, context: 0.94 });
    fixture.detectChanges();
    expect(root.textContent).toContain("Context 94% full");
    expect(root.querySelector("[exAutoHeight]")?.hasAttribute("inert")).toBe(false);
    fixture.componentRef.setInput("agent", {
      ...agent,
      context: 0.94,
      plan: { ...agent.plan, win: 0 },
    });
    fixture.detectChanges();
    expect(root.textContent).toContain("Codex plan limit reached");
    expect(root.querySelector("button")).toBeNull();
    fixture.componentRef.setInput("agent", {
      ...agent,
      context: 0.2,
      plan: undefined,
    });
    fixture.detectChanges();
    expect(root.querySelector(".notice:not(.notice-leave)")).toBeNull();
  });
  it("renders only actual provider windows and names the tighter model-specific allowance", () => {
    const plan = {
      name: "Claude plan",
      windows: [
        { id: "opus", label: "Weekly Opus limit", weekly: true, left: 0.08 },
      ],
    };
    const fixture = TestBed.createComponent(AgentUsageComponent);
    fixture.componentRef.setInput("agent", {
      mark: "Cl",
      harness: "claude",
      model: "opus",
      plan,
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Weekly Opus limit");
    expect(fixture.nativeElement.textContent).not.toContain("5-hour");
    expect(
      fixture.nativeElement
        .querySelector('[role="meter"]')
        .getAttribute("aria-valuenow"),
    ).toBe("8");
    const meter = TestBed.createComponent(AgentPlanMeterComponent);
    meter.componentRef.setInput("plan", plan);
    meter.detectChanges();
    expect(meter.nativeElement.getAttribute("aria-label")).toContain(
      "8% of the weekly opus limit left",
    );
  });
});
