import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { ShellToolComponent } from "./shell-tool.component";
import { ToolStepComponent } from "./tool-step.component";
import type { ShellToolPresentation } from "../tool-presentation";

const shell = (
  extra: Partial<ShellToolPresentation> = {},
): ShellToolPresentation => ({
  command: "pnpm test\npnpm lint",
  directory: "/workspace/elevenex/task",
  description: "Check the changes",
  output: "\u001b[32mpassed\u001b[0m\n<script>bad()</script>",
  interrupted: false,
  failed: false,
  commandShortened: false,
  outputShortened: false,
  ...extra,
});

describe("shell disclosure", () => {
  it("mounts lazily, keeps content inert and forwards copy through the owner", () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    fixture.componentRef.setInput("detail", "pnpm test");
    fixture.componentRef.setInput("presentation", {
      summary: "pnpm test",
      blocks: [],
      shell: shell(),
    });
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector("ex-shell-tool")).toBeNull();
    host.querySelector<HTMLButtonElement>(".head")!.click();
    fixture.detectChanges();
    expect(host.querySelector(".terminal-line")?.textContent).toBe("passed");
    expect(host.querySelector("script")).toBeNull();
    const copies: string[] = [];
    fixture.componentInstance.copyCode.subscribe((text) => copies.push(text));
    host
      .querySelector<HTMLButtonElement>('[aria-label="Copy captured output"]')!
      .click();
    expect(copies).toEqual(["passed\n<script>bad()</script>"]);
    host
      .querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!
      .click();
    expect(copies.at(-1)).toBe("pnpm test\npnpm lint");
    fixture.componentRef.setInput("copiedCode", copies.at(-1));
    fixture.detectChanges();
    expect(host.querySelector('[aria-label="Command copied"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".head")!.click();
    fixture.detectChanges();
    expect(host.querySelector("ex-fold")?.hasAttribute("inert")).toBe(true);
    fixture.destroy();
  });
  it("bounds output, keeps wrapping through receipt updates and expands on request", () => {
    const fixture = TestBed.createComponent(ShellToolComponent);
    const output = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    fixture.componentRef.setInput("shell", shell({ output }));
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelectorAll(".terminal-line")).toHaveLength(80);
    host
      .querySelector<HTMLButtonElement>('[aria-label="Wrap output"]')!
      .click();
    fixture.detectChanges();
    expect(host.querySelector(".screen")?.classList.contains("wrap")).toBe(
      false,
    );
    fixture.componentRef.setInput(
      "shell",
      shell({ output: output + "\nfinished" }),
    );
    fixture.detectChanges();
    expect(host.querySelector(".screen")?.classList.contains("wrap")).toBe(
      false,
    );
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Show more lines"))!
      .click();
    fixture.detectChanges();
    expect(host.querySelectorAll(".terminal-line")).toHaveLength(1000);
    expect(host.querySelector(".screen")?.textContent).toContain("finished");
    fixture.destroy();
  });
  it("retains the output being read across tail eviction and resumes on request", () => {
    const fixture = TestBed.createComponent(ShellToolComponent);
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    fixture.componentRef.setInput("shell", shell({ output }));
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const screen = host.querySelector<HTMLElement>(".screen")!;
    Object.defineProperties(screen, {
      scrollHeight: { configurable: true, value: 1600 },
      clientHeight: { configurable: true, value: 320 },
    });
    screen.scrollTop = 100;
    screen.dispatchEvent(new Event("scroll"));
    fixture.detectChanges();
    const reading = screen.textContent;
    fixture.componentRef.setInput(
      "shell",
      shell({ output: output + "\n" + "new result\n".repeat(100) }),
    );
    fixture.detectChanges();
    expect(screen.textContent).toBe(reading);
    expect(host.textContent).toContain("New output available");
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Jump to latest"))!
      .click();
    fixture.detectChanges();
    expect(screen.textContent).toContain("new result");
    expect(screen.textContent).not.toBe(reading);
    fixture.destroy();
  });

  it("distinguishes running, missing, interrupted, failed and empty successful receipts", () => {
    const fixture = TestBed.createComponent(ShellToolComponent);
    const host: HTMLElement = fixture.nativeElement;
    fixture.componentRef.setInput("shell", shell({ output: "" }));
    for (const [status, message] of [
      ["running", "Waiting for output"],
      ["unknown", "No result was recorded"],
      ["failed", "Command failed"],
      ["done", "Command completed"],
    ]) {
      fixture.componentRef.setInput("status", status);
      fixture.detectChanges();
      expect(host.querySelector(".empty")?.textContent).toContain(message);
    }
    fixture.componentRef.setInput(
      "shell",
      shell({ output: "", interrupted: true }),
    );
    fixture.detectChanges();
    expect(host.querySelector(".empty")?.textContent).toContain("interrupted");
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Copy captured output"]',
      )?.disabled,
    ).toBe(true);
    fixture.destroy();
  });
});
