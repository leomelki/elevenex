import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnStatus, WorkStep } from "../conversation.models";
import { TurnComponent } from "./turn.component";

@Component({
  imports: [TurnComponent],
  template: `<ex-turn [status]="status()" [steps]="steps()" [duration]="12">
    <p>Hi. How can I help?</p>
  </ex-turn>`,
})
class ReplyHostComponent {
  readonly status = signal<TurnStatus>("done");
  readonly steps = signal<readonly WorkStep[]>([]);
}

describe("turn work disclosure", () => {
  it.each(["done", "failed", "stopped"] as const)(
    "shows the answer directly without empty work for a %s turn",
    (status) => {
      const fixture = TestBed.createComponent(ReplyHostComponent);
      fixture.componentInstance.status.set(status);
      fixture.detectChanges();
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelector(".work-row")).toBeNull();
      expect(host.querySelector("ex-work-timeline")).toBeNull();
      expect(host.querySelector(".work-region")?.hasAttribute("inert")).toBe(true);
      expect(host.querySelector(".answer")?.textContent).toContain(
        "Hi. How can I help?",
      );
      if (status !== "done") {
        expect(host.querySelector(".error")?.textContent).toContain(
          status === "failed" ? "Retry" : "Continue",
        );
      }
      fixture.destroy();
    },
  );

  it("retains an inert live heading through completion and an interrupted reopen", () => {
    const fixture = TestBed.createComponent(ReplyHostComponent);
    fixture.componentInstance.status.set("live");
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector(".work-row")?.textContent).toContain("Working");
    const stop = host.querySelector<HTMLButtonElement>(".work-row button[exButton]")!;
    const turn = host.querySelector("ex-turn")!;
    const answer = host.querySelector(".answer");
    const row = host.querySelector(".work-row");
    expect(stop.textContent).toContain("Stop");
    fixture.componentInstance.status.set("done");
    fixture.detectChanges();
    expect(host.querySelector("ex-turn")).toBe(turn);
    expect(host.querySelector(".work-row")).toBe(row);
    expect(row?.textContent).toContain("Working");
    expect(row?.textContent).not.toContain("Worked");
    expect(host.querySelector(".work-region")?.hasAttribute("inert")).toBe(true);
    expect(stop.disabled).toBe(true);
    expect(host.querySelector(".answer")).toBe(answer);
    expect(host.querySelector(".answer")?.textContent).toContain("Hi.");
    fixture.componentInstance.status.set("live");
    fixture.detectChanges();
    expect(host.querySelectorAll(".work-row")).toHaveLength(1);
    expect(host.querySelector(".work-row")).toBe(row);
    expect(host.querySelector(".work-region")?.hasAttribute("inert")).toBe(false);
    expect(stop.disabled).toBe(false);
    fixture.destroy();
  });

  it("moves focus out of closing work without stealing focus from other controls", () => {
    const fixture = TestBed.createComponent(ReplyHostComponent);
    const host: HTMLElement = fixture.nativeElement;
    const other = document.createElement("button");
    document.body.append(host, other);
    fixture.componentInstance.status.set("live");
    fixture.detectChanges();
    const turn = host.querySelector<HTMLElement>("ex-turn")!;
    host.querySelector<HTMLButtonElement>(".work-row button[exButton]")!.focus();
    fixture.componentInstance.status.set("done");
    fixture.detectChanges();
    expect(document.activeElement).toBe(turn);
    fixture.componentInstance.status.set("live");
    fixture.detectChanges();
    other.focus();
    fixture.componentInstance.status.set("done");
    fixture.detectChanges();
    expect(document.activeElement).toBe(other);
    fixture.destroy();
    host.remove();
    other.remove();
  });

  it("does not count commentary and completion notes as work", () => {
    const fixture = TestBed.createComponent(ReplyHostComponent);
    fixture.componentInstance.steps.set([
      { id: "say", kind: "say", text: "Checking the details." },
      { id: "completed", kind: "note", text: "Turn completed" },
    ]);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector(".work-row")).toBeNull();
    expect(host.querySelector("ex-work-timeline")).toBeNull();
    expect(host.querySelector(".answer")?.textContent).toContain("Hi.");
    fixture.destroy();
  });

  it("retains the work disclosure for tool and thinking steps", () => {
    const fixture = TestBed.createComponent(ReplyHostComponent);
    const host: HTMLElement = fixture.nativeElement;
    for (const step of [
      { id: "read", kind: "read", status: "done", detail: "README.md" },
      { id: "think", kind: "think", text: "Checking the details." },
    ] as const) {
      fixture.componentInstance.steps.set([step]);
      fixture.detectChanges();
      const work = host.querySelector<HTMLButtonElement>(".work")!;
      expect(work.textContent).toContain("Worked 12s");
      expect(work.getAttribute("aria-expanded")).toBe("false");
      work.click();
      fixture.detectChanges();
      expect(work.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector("ex-work-timeline ex-tool-step")).not.toBeNull();
      work.click();
      fixture.detectChanges();
    }
    fixture.destroy();
  });
});

interface EvidenceObservation {
  target?: Element;
  resize: () => void;
  disconnect: () => void;
}

describe("turn evidence", () => {
  it("restores focus when an inspected live tool completes and resets disclosure for the next tool", async () => {
    const fixture = TestBed.createComponent(TurnComponent);
    const host: HTMLElement = fixture.nativeElement;
    document.body.append(host);
    fixture.componentRef.setInput("status", "live");
    const running = {
      id: "first",
      kind: "run",
      detail: "pnpm test",
      status: "running",
      presentation: {
        summary: "pnpm test",
        blocks: [{ kind: "code", title: "Command", text: "pnpm test" }],
      },
    } as const;
    fixture.componentRef.setInput("steps", [running]);
    fixture.detectChanges();
    await fixture.whenStable();
    const head = host.querySelector<HTMLButtonElement>("ex-now-line .head")!;
    head.click();
    head.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fixture.componentRef.setInput("steps", [{ ...running, id: "second" }]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(host.querySelector(".work"));
    const next = host.querySelector<HTMLButtonElement>("ex-now-line .head")!;
    expect(next).not.toBe(head);
    expect(next.getAttribute("aria-expanded")).toBe("false");
    next.focus();
    fixture.componentRef.setInput("status", "done");
    fixture.componentRef.setInput("steps", [
      { ...running, id: "second", status: "done" },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(host.querySelector(".work"));
    fixture.destroy();
    host.remove();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("updates overflow after resize and releases the observer when evidence leaves", async () => {
    const observations: EvidenceObservation[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly observation: EvidenceObservation;
        constructor(callback: () => void) {
          this.observation = { resize: callback, disconnect: vi.fn() };
          observations.push(this.observation);
        }
        observe(target: Element): void {
          this.observation.target = target;
        }
        disconnect(): void {
          this.observation.disconnect();
        }
      },
    );
    const fixture = TestBed.createComponent(TurnComponent);
    fixture.componentRef.setInput("steps", [
      { id: "think", kind: "think", text: "Checking the styles." },
    ]);
    fixture.componentRef.setInput("files", [
      { path: "turn.css", add: 83, del: 12 },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    const evidence = host.querySelector<HTMLElement>(".facts");
    expect(evidence).not.toBeNull();
    const observation = observations.find((item) => item.target === evidence);
    expect(observation).toBeDefined();
    if (!evidence || !observation) throw new Error("Missing evidence observer");
    Object.defineProperty(evidence, "scrollWidth", { value: 400 });
    Object.defineProperty(evidence, "clientWidth", {
      value: 180,
      configurable: true,
    });
    observation.resize();
    await fixture.whenStable();
    expect(evidence.classList.contains("clipped")).toBe(true);
    Object.defineProperty(evidence, "clientWidth", { value: 500 });
    observation.resize();
    await fixture.whenStable();
    expect(evidence.classList.contains("clipped")).toBe(false);
    fixture.componentRef.setInput("status", "live");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector(".facts")).toBe(evidence);
    fixture.componentRef.setInput("files", []);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector(".facts")).toBeNull();
    expect(observation.disconnect).toHaveBeenCalledOnce();
    fixture.componentRef.setInput("files", [{ path: "turn.css" }]);
    fixture.componentRef.setInput("status", "done");
    fixture.detectChanges();
    await fixture.whenStable();
    const restored = observations.find(
      (item) => item.target === host.querySelector(".facts"),
    );
    fixture.destroy();
    expect(restored?.disconnect).toHaveBeenCalledOnce();
  });
  it("keeps overlapping running tools before later commentary in the timeline", () => {
    const fixture = TestBed.createComponent(TurnComponent);
    fixture.componentRef.setInput("status", "live");
    fixture.componentRef.setInput("steps", [
      { id: "tool", kind: "run", status: "running", detail: "Long command" },
      { id: "say", kind: "say", text: "Still checking" },
    ]);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const tool = host.querySelector("ex-tool-step")!;
    const commentary = host.querySelector(".prose")!;
    expect(
      tool.compareDocumentPosition(commentary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(host.querySelector("ex-now-line")).toBeNull();
    expect(host.querySelector(".facts")).toBeNull();
    fixture.destroy();
  });
});
