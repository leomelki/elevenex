import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { ToolStepComponent } from "./tool-step.component";
import type { ToolPresentation } from "../tool-presentation";

describe("tool evidence", () => {
  it("keeps output inert, distinguishes proposed changes and makes closed content inert", () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    const presentation: ToolPresentation = {
      summary: "retry.ts",
      blocks: [
        { kind: "fields", fields: [{ label: "File", value: "retry.ts" }] },
        {
          kind: "diff",
          title: "Replacement",
          before: "  old()",
          after: "  new()",
        },
        { kind: "patch", title: "Patch", text: "@@ -1 +1 @@\n-old()\n+new()" },
        {
          kind: "text",
          title: "Result",
          text: "<script>window.toolExecuted = true</script>",
        },
        {
          kind: "list",
          title: "Plan",
          items: [{ label: "Verify recovery", status: "pending" }],
        },
      ],
    };
    fixture.componentRef.setInput("detail", presentation.summary);
    fixture.componentRef.setInput("presentation", presentation);
    fixture.componentRef.setInput("output", "Original input");
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const button = host.querySelector<HTMLButtonElement>(".head")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("ex-fold")?.hasAttribute("inert")).toBe(true);
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("ex-fold")?.hasAttribute("inert")).toBe(false);
    expect(host.querySelector(".diff .removed code")?.textContent).toBe(
      "  old()",
    );
    expect(host.querySelector(".diff .added code")?.textContent).toBe(
      "  new()",
    );
    expect(host.querySelector(".patch .context")?.textContent).toBe(
      "@@ -1 +1 @@",
    );
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector(".tool-text")?.textContent).toContain("<script>");
    expect(
      host.querySelector('.tool-rows [aria-label="Queued"]'),
    ).not.toBeNull();
    expect(host.querySelector(".raw-details pre")).toBeNull();
    const details = host.querySelector<HTMLDetailsElement>("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    fixture.detectChanges();
    const original = details.querySelector<HTMLDetailsElement>('.raw-details')!;
    original.open = true;
    original.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    expect(original.querySelector("pre")?.textContent).toBe("Original input");
    button.click();
    fixture.detectChanges();
    expect(host.querySelector("ex-fold")?.hasAttribute("inert")).toBe(true);
    fixture.destroy();
  });

  it('shows only the chosen outcome until details are requested, with original data one level deeper', () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    fixture.componentRef.setInput('detail', 'pnpm test');
    fixture.componentRef.setInput('presentation', {
      summary: 'pnpm test',
      preview: [{ kind: 'code', text: '12 tests passed.' }],
      previewNotice: '8 more lines',
      blocks: [
        { kind: 'fields', fields: [{ label: 'Working directory', value: '/workspace/payments' }] },
        { kind: 'code', title: 'Command', text: 'pnpm test' },
        { kind: 'code', title: 'Output', text: '12 tests passed.\nAdditional diagnostic output' },
      ],
    });
    fixture.componentRef.setInput('output', '{"command":"pnpm test"}');
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    host.querySelector<HTMLButtonElement>('.head')!.click();
    fixture.detectChanges();
    expect(host.querySelector('.tool-preview')?.textContent?.trim()).toBe('12 tests passed.');
    expect(host.textContent).not.toContain('/workspace/payments');
    expect(host.querySelector('.tool-details')).toBeNull();
    const more = host.querySelector<HTMLDetailsElement>('.more-details')!;
    expect(more.querySelector('summary')?.textContent).toContain('8 more lines');
    more.open = true; more.dispatchEvent(new Event('toggle')); fixture.detectChanges();
    expect(host.querySelector('.tool-details')?.textContent).toContain('/workspace/payments');
    expect(host.querySelector('.raw-details pre')).toBeNull();
    const raw = host.querySelector<HTMLDetailsElement>('.raw-details')!;
    raw.open = true; raw.dispatchEvent(new Event('toggle')); fixture.detectChanges();
    expect(raw.querySelector('pre')?.textContent).toContain('"command"');
    more.open = false; more.dispatchEvent(new Event('toggle')); fixture.detectChanges();
    expect(host.querySelector('.tool-details')).toBeNull();
    expect(host.querySelector('.tool-preview')?.textContent).toContain('12 tests passed.');
    fixture.destroy();
  });

  it("updates a running tool in place without resetting its disclosure", () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    fixture.componentRef.setInput("detail", "pnpm test");
    fixture.componentRef.setInput("status", "running");
    fixture.componentRef.setInput("presentation", {
      summary: "pnpm test",
      blocks: [{ kind: "code", title: "Command", text: "pnpm test" }],
    });
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const button = host.querySelector<HTMLButtonElement>(".head")!;
    button.click();
    fixture.detectChanges();
    fixture.componentRef.setInput("status", "failed");
    fixture.componentRef.setInput("presentation", {
      summary: "pnpm test",
      blocks: [{ kind: "code", title: "Error output", text: "1 failed" }],
    });
    fixture.detectChanges();
    expect(host.querySelector(".head")).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".tool-content")?.textContent).toContain(
      "1 failed",
    );
    expect(host.querySelector("section.failed")).not.toBeNull();
    fixture.destroy();
  });
});
