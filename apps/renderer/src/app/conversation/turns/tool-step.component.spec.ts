import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolStepComponent } from "./tool-step.component";
import type { ToolDetailsProvider, ToolDetailsState, ToolPresentation } from "../tool-presentation";

afterEach(() => vi.useRealTimers());

describe("tool evidence", () => {
  it("keeps a pending read out of the layout and keeps the disclosure focused through retry", () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(ToolStepComponent);
    const inspection = signal<ToolDetailsState>({ status: 'loading' });
    const retry = vi.fn();
    const inspect = vi.fn<ToolDetailsProvider>(() => ({ state: inspection, retry }));
    fixture.componentRef.setInput("detail", "pnpm test");
    fixture.componentRef.setInput("deferred", { item: { id: 'call', revision: 'a'.repeat(64) } });
    fixture.componentRef.setInput("inspect", inspect);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const button = host.querySelector<HTMLButtonElement>('.head')!;
    button.focus();
    expect(inspect).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    fixture.detectChanges();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.detail-notice')).toBeNull();
    const [, abort] = inspect.mock.calls[0]!;
    fixture.componentRef.setInput("deferred", { item: { id: 'call', revision: 'a'.repeat(64) } });
    fixture.detectChanges();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(abort.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(host.querySelector('ex-fold')?.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('.detail-notice')).toBeNull();
    inspection.set({ status: 'error', reason: 'failed' });
    fixture.detectChanges();
    const retryButton = host.querySelector<HTMLButtonElement>('.detail-notice button')!;
    retryButton.focus();
    retryButton.click();
    expect(document.activeElement).toBe(button);
    expect(retry).toHaveBeenCalledOnce();
    inspection.set({ status: 'ready', evidence: {
      output: '', presentation: { summary: 'pnpm test', blocks: [{ kind: 'code', text: '12 tests passed.' }] },
    } });
    fixture.detectChanges();
    expect(host.querySelector('.tool-preview')?.textContent).toContain('12 tests passed.');
    expect(button.hasAttribute('aria-busy')).toBe(false);
    button.click();
    fixture.detectChanges();
    expect(abort.aborted).toBe(true);
    expect(host.querySelector('ex-fold')?.hasAttribute('inert')).toBe(true);
    fixture.destroy();
  });

  it("warms closed evidence on a hover dwell or press and cues only a slow open", () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(ToolStepComponent);
    const inspection = signal<ToolDetailsState>({ status: 'loading' });
    const prefetch = vi.fn();
    const inspect = Object.assign(vi.fn(() => ({ state: inspection, retry: () => undefined })), { prefetch });
    const deferred = { item: { id: 'call', revision: 'a'.repeat(64) } };
    fixture.componentRef.setInput("detail", "pnpm test");
    fixture.componentRef.setInput("deferred", deferred);
    fixture.componentRef.setInput("inspect", inspect);
    fixture.detectChanges();
    const head = fixture.nativeElement.querySelector('.head') as HTMLButtonElement;
    const pointer = (type: string, pointerType = 'mouse') =>
      head.dispatchEvent(Object.assign(new Event(type), { pointerType, button: 0 }));

    pointer('pointerenter');
    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    pointer('pointerleave');
    fixture.detectChanges();
    vi.advanceTimersByTime(200);
    expect(prefetch).not.toHaveBeenCalled();
    pointer('pointerenter');
    fixture.detectChanges();
    vi.advanceTimersByTime(100);
    expect(prefetch).toHaveBeenCalledOnce();
    expect(prefetch).toHaveBeenCalledWith(deferred);

    pointer('pointerdown', 'touch');
    fixture.detectChanges();
    expect(prefetch).toHaveBeenCalledOnce();
    pointer('pointerdown');
    fixture.detectChanges();
    expect(prefetch).toHaveBeenCalledTimes(2);

    head.click();
    fixture.detectChanges();
    expect(inspect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(119);
    fixture.detectChanges();
    expect(head.classList).not.toContain('pending');
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(head.classList).toContain('pending');
    inspection.set({ status: 'ready', evidence: { output: 'ok', presentation: { summary: 'pnpm test', blocks: [] } } });
    fixture.detectChanges();
    expect(head.classList).not.toContain('pending');
    expect(prefetch).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it("colors literal whole-file contents and preserves whitespace without adding a terminal row", () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    fixture.componentRef.setInput("detail", "skill-test.txt");
    fixture.componentRef.setInput("presentation", {
      summary: "1 file",
      blocks: [
        {
          kind: "diff",
          title: "skill-test.txt",
          before: "",
          after: "++counter\r\n--comment\r\n  keep spaces  \r\n\r\n",
        },
        { kind: "diff", title: "removed.txt", before: "  old  \n", after: "" },
      ],
    });
    fixture.componentRef.setInput("open", true);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(
      [...host.querySelectorAll(".added code")].map((code) => code.textContent),
    ).toEqual(["++counter", "--comment", "  keep spaces  ", " "]);
    expect(host.querySelector(".removed code")?.textContent).toBe("  old  ");
    expect(
      [...host.querySelectorAll(".added .sign")].every(
        (sign) => sign.textContent === "+",
      ),
    ).toBe(true);
    fixture.destroy();
  });

  it("keeps file headers neutral while coloring triple-prefix lines inside a patch hunk", () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    fixture.componentRef.setInput("detail", "literal.ts");
    fixture.componentRef.setInput("presentation", {
      summary: "1 file",
      blocks: [
        {
          kind: "patch",
          text: "--- a/literal.ts\r\n+++ b/literal.ts\r\n@@ -1 +1 @@\r\n---old\r\n+++new\r\n",
        },
      ],
    });
    fixture.componentRef.setInput("open", true);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(
      [...host.querySelectorAll(".context code")].map(
        (code) => code.textContent,
      ),
    ).toEqual(["--- a/literal.ts", "+++ b/literal.ts", "@@ -1 +1 @@"]);
    expect(host.querySelector(".removed code")?.textContent).toBe("--old");
    expect(host.querySelector(".added code")?.textContent).toBe("++new");
    expect(host.querySelector(".removed .sign")?.textContent).toBe("−");
    expect(host.querySelector(".added .sign")?.textContent).toBe("+");
    expect(host.querySelectorAll(".diff-line")).toHaveLength(5);
    fixture.destroy();
  });

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
    const original = details.querySelector<HTMLDetailsElement>(".raw-details")!;
    original.open = true;
    original.dispatchEvent(new Event("toggle"));
    fixture.detectChanges();
    expect(original.querySelector("pre")?.textContent).toBe("Original input");
    button.click();
    fixture.detectChanges();
    expect(host.querySelector("ex-fold")?.hasAttribute("inert")).toBe(true);
    fixture.destroy();
  });

  it("shows only the chosen outcome until details are requested, with original data one level deeper", () => {
    const fixture = TestBed.createComponent(ToolStepComponent);
    fixture.componentRef.setInput("detail", "pnpm test");
    fixture.componentRef.setInput("presentation", {
      summary: "pnpm test",
      preview: [{ kind: "code", text: "12 tests passed." }],
      previewNotice: "8 more lines",
      blocks: [
        {
          kind: "fields",
          fields: [
            { label: "Working directory", value: "/workspace/payments" },
          ],
        },
        { kind: "code", title: "Command", text: "pnpm test" },
        {
          kind: "code",
          title: "Output",
          text: "12 tests passed.\nAdditional diagnostic output",
        },
      ],
    });
    fixture.componentRef.setInput("output", '{"command":"pnpm test"}');
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    host.querySelector<HTMLButtonElement>(".head")!.click();
    fixture.detectChanges();
    expect(host.querySelector(".tool-preview")?.textContent?.trim()).toBe(
      "12 tests passed.",
    );
    expect(host.textContent).not.toContain("/workspace/payments");
    expect(host.querySelector(".tool-details")).toBeNull();
    const more = host.querySelector<HTMLDetailsElement>(".more-details")!;
    expect(more.querySelector("summary")?.textContent).toContain(
      "8 more lines",
    );
    more.open = true;
    more.dispatchEvent(new Event("toggle"));
    fixture.detectChanges();
    expect(host.querySelector(".tool-details")?.textContent).toContain(
      "/workspace/payments",
    );
    expect(host.querySelector(".raw-details pre")).toBeNull();
    const raw = host.querySelector<HTMLDetailsElement>(".raw-details")!;
    raw.open = true;
    raw.dispatchEvent(new Event("toggle"));
    fixture.detectChanges();
    expect(raw.querySelector("pre")?.textContent).toContain('"command"');
    more.open = false;
    more.dispatchEvent(new Event("toggle"));
    fixture.detectChanges();
    expect(host.querySelector(".tool-details")).toBeNull();
    expect(host.querySelector(".tool-preview")?.textContent).toContain(
      "12 tests passed.",
    );
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
