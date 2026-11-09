import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageComponent } from "./message.component";
import { TurnComponent } from "../turns/turn.component";

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe("agent reply marks", () => {
  for (const component of [MessageComponent, TurnComponent]) {
    it(`preserves legacy monograms and updates explicit harness logos in ${component.name}`, () => {
      const fixture = TestBed.createComponent<MessageComponent | TurnComponent>(component);
      if (component === MessageComponent) fixture.componentRef.setInput("role", "agent");
      fixture.componentRef.setInput("author", "Claude Code");
      fixture.componentRef.setInput("time", "10:42");
      fixture.componentRef.setInput("mark", "CL");
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      const mark = root.querySelector(".mark");
      // Display names alone must never guess a harness identity.
      expect(mark?.textContent?.trim()).toBe("CL");
      expect(mark?.querySelector("svg")).toBeNull();

      fixture.componentRef.setInput("harness", "claude");
      fixture.detectChanges();
      expect(root.querySelector(".mark")).toBe(mark);
      const claudePath = mark?.querySelector("path")?.getAttribute("d");
      expect(claudePath).toBeTruthy();
      expect(mark?.textContent?.trim()).toBe("");
      expect(mark?.getAttribute("title")).toBe("Claude Code · 10:42");
      expect(mark?.getAttribute("aria-label")).toBe("Claude Code");
      expect(mark?.getAttribute("role")).toBe("img");

      fixture.componentRef.setInput("harness", "codex");
      fixture.detectChanges();
      expect(mark?.querySelector("path")?.getAttribute("d")).not.toBe(claudePath);
      const gradient = mark?.querySelector("linearGradient");
      expect(gradient?.id).toBeTruthy();
      expect(mark?.querySelector("path")?.getAttribute("fill")).toBe(`url(#${gradient?.id})`);

      fixture.componentRef.setInput("harness", "custom-agent");
      fixture.componentRef.setInput("mark", "CA");
      fixture.detectChanges();
      expect(mark?.querySelector("svg")).toBeNull();
      expect(mark?.textContent?.trim()).toBe("CA");
      expect(mark?.querySelector("ex-agent-mark")?.getAttribute("data-harness")).toBeNull();
      fixture.destroy();
    });
  }

  it("keeps repeated Codex replies' gradient references independent when one leaves", () => {
    const replies = [TestBed.createComponent(TurnComponent), TestBed.createComponent(TurnComponent)];
    for (const reply of replies) {
      reply.componentRef.setInput("harness", "codex");
      reply.detectChanges();
    }
    const [first, second] = replies;
    const firstId = first!.nativeElement.querySelector("linearGradient").id;
    const secondId = second!.nativeElement.querySelector("linearGradient").id;
    expect(firstId).not.toBe(secondId);
    first!.destroy();
    expect(second!.nativeElement.querySelector("path").getAttribute("fill")).toBe(`url(#${secondId})`);
    expect(second!.nativeElement.querySelector("linearGradient").id).toBe(secondId);
    second!.destroy();
  });

  it("keeps harness marks out of user messages", () => {
    const fixture = TestBed.createComponent(MessageComponent);
    fixture.componentRef.setInput("harness", "codex");
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".mark")).toBeNull();
    fixture.destroy();
  });
});
