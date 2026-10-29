import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnComponent } from "./turn.component";

interface EvidenceObservation {
  target?: Element;
  resize: () => void;
  disconnect: () => void;
}

describe("turn evidence", () => {
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
    expect(tool.compareDocumentPosition(commentary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector("ex-now-line")).toBeNull();
    expect(host.querySelector(".facts")).toBeNull();
    fixture.destroy();
  });
});
