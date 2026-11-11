import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionChatWork } from "@elevenex/shared";
import { SessionActivityComponent } from "./session-activity.component";

afterEach(() => TestBed.resetTestingModule());
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const running: SessionChatWork["running"][number] = {
  id: "task:shell",
  kind: "task",
  label: "pnpm test --watch",
  detail: "Last used Bash",
  startedAt: ago(4 * 60_000),
  stoppable: true,
  orphaned: true,
};
const failure: SessionChatWork["recent"][number] = {
  id: "hook:1",
  kind: "hook",
  tone: "danger",
  title: "PostToolUse:Edit hook failed",
  detail: "exit 2",
  at: ago(60_000),
};
const overlay = () => document.querySelector<HTMLElement>(".cdk-overlay-container .panel");

function mount(work: SessionChatWork) {
  const fixture = TestBed.createComponent(SessionActivityComponent);
  fixture.componentRef.setInput("work", work);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, root, trigger: () => root.querySelector<HTMLButtonElement>(".trigger") };
}

describe("session activity", () => {
  it("stays absent with nothing to show and stays quiet for routine history", () => {
    const { fixture, trigger } = mount({ running: [], recent: [] });
    expect(trigger()).toBeNull();
    fixture.componentRef.setInput("work", {
      running: [],
      recent: [{ ...failure, id: "c", kind: "compaction", tone: "info", title: "Context compacted" }],
    });
    fixture.detectChanges();
    expect(trigger()?.dataset["mode"]).toBe("quiet");
    expect(trigger()?.getAttribute("aria-label")).toBe("Recent activity");
    expect(trigger()?.textContent?.trim()).toBe("");
  });

  it("summarizes running work and stops one item through the owner", () => {
    const { fixture, trigger } = mount({ running: [running], recent: [failure] });
    const stops: string[] = [];
    fixture.componentInstance.stopRequested.subscribe((id) => stops.push(id));
    expect(trigger()?.dataset["mode"]).toBe("running");
    expect(trigger()?.textContent).toContain("1 in background");
    expect(trigger()?.textContent).toContain("4m");
    trigger()!.click();
    fixture.detectChanges();
    const panel = overlay()!;
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain("pnpm test --watch");
    expect(panel.textContent).toContain("Left behind");
    expect(panel.textContent).toContain("PostToolUse:Edit hook failed");
    const stop = panel.querySelector<HTMLButtonElement>('button[aria-label="Stop pnpm test --watch"]')!;
    stop.click();
    expect(stops).toEqual(["task:shell"]);
    fixture.componentRef.setInput("stopping", true);
    fixture.detectChanges();
    // Only the requested row reports progress; its controls give way to the status.
    expect(panel.querySelector(".work .pending")?.textContent?.trim()).toBe("Stopping…");
    expect(panel.querySelector('button[aria-label="Stop pnpm test --watch"]')).toBeNull();
    // A finished item leaves; the open panel explains instead of vanishing under focus.
    fixture.componentRef.setInput("stopping", false);
    fixture.componentRef.setInput("work", { running: [], recent: [] });
    fixture.detectChanges();
    expect(overlay()?.textContent).toContain("Nothing is running in the background.");
    fixture.componentInstance.close();
    fixture.detectChanges();
    expect(trigger()).toBeNull();
  });

  it("flags recent issues until the panel is opened", () => {
    const { fixture, trigger } = mount({ running: [], recent: [failure, { ...failure, id: "old", at: ago(2 * 3_600_000) }] });
    expect(trigger()?.dataset["mode"]).toBe("issue");
    expect(trigger()?.textContent).toContain("1 issue");
    trigger()!.click();
    fixture.detectChanges();
    fixture.componentInstance.close();
    fixture.detectChanges();
    expect(trigger()?.dataset["mode"]).toBe("quiet");
  });

  it("never offers Stop for items the harness cannot stop or while stopping is unavailable", () => {
    const { fixture, trigger } = mount({ running: [{ ...running, stoppable: false }, { ...running, id: "task:b", label: "Other" }], recent: [] });
    fixture.componentRef.setInput("stopDisabled", true);
    fixture.detectChanges();
    trigger()!.click();
    fixture.detectChanges();
    const buttons = [...overlay()!.querySelectorAll<HTMLButtonElement>('.work button[aria-label^="Stop "]')];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Stop Other"]);
    expect(buttons[0]!.disabled).toBe(true);
  });
});

describe("session activity rows", () => {
  it("opens agents from the row and folds long failure output behind Show more", () => {
    const long = Array.from({ length: 8 }, (_, line) => `line ${line}`).join("\n");
    const { fixture, trigger } = mount({
      running: [{ ...running, id: "subagent:a", kind: "agent", label: "Reviewer", agentId: "a", inspectable: true, orphaned: false }],
      recent: [{ ...failure, detail: long }],
    });
    const inspected: string[] = [];
    fixture.componentInstance.inspectRequested.subscribe((id) => inspected.push(id));
    trigger()!.click();
    fixture.detectChanges();
    const panel = overlay()!;
    panel.querySelector<HTMLButtonElement>('button[aria-label="Inspect Reviewer"]')!.click();
    expect(inspected).toEqual(["a"]);
    const output = panel.querySelector<HTMLElement>(".event pre")!;
    const more = panel.querySelector<HTMLButtonElement>(".event .more")!;
    expect(output.classList).toContain("clamped");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    fixture.detectChanges();
    expect(output.classList).not.toContain("clamped");
    expect(more.textContent?.trim()).toBe("Show less");
  });
});

describe("session activity sections", () => {
  const waiting: SessionChatWork["running"][number] = {
    ...running,
    id: "subagent:planner",
    kind: "agent",
    label: "Confirm retry window · planner",
    title: "Confirm retry window",
    role: "planner",
    detail: "",
    status: "waiting",
    orphaned: false,
  };

  it("lists work that needs a decision first and hands Answer off after closing", async () => {
    const { fixture, trigger } = mount({ running: [waiting, running], recent: [] });
    fixture.componentRef.setInput("decisionPending", true);
    let answered = 0;
    fixture.componentInstance.answerRequested.subscribe(() => answered++);
    expect(trigger()?.textContent).toContain("1 needs you");
    trigger()!.click();
    fixture.detectChanges();
    const panel = overlay()!;
    const headings = [...panel.querySelectorAll("h3")].map((h) => h.textContent?.replace(/\s+/g, " ").trim());
    expect(headings).toEqual(["Needs you 1", "Running 1"]);
    const first = panel.querySelector<HTMLElement>(".work")!;
    expect(first.dataset["status"]).toBe("waiting");
    expect(first.querySelector(".title")?.textContent).toBe("Confirm retry window");
    expect(first.querySelector(".role")?.textContent).toBe("planner");
    first.querySelector<HTMLButtonElement>(".answer")!.click();
    fixture.detectChanges();
    expect(overlay()).toBeNull();
    await fixture.whenStable();
    expect(answered).toBe(1);
  });

  it("offers Answer only when the conversation holds a decision", () => {
    const { fixture, trigger } = mount({ running: [waiting], recent: [] });
    trigger()!.click();
    fixture.detectChanges();
    expect(overlay()!.querySelector(".answer")).toBeNull();
    expect(overlay()!.textContent).toContain("Waiting for your decision");
  });
});
