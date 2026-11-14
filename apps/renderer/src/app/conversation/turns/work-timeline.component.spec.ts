import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComponent } from "../chat/chat.component";
import type { ChatExchange, WorkStep } from "../conversation.models";

const tool = (id: string, extra: Partial<WorkStep> = {}): WorkStep => ({
  id,
  kind: "run",
  detail: id,
  status: "done",
  output: `Output for ${id}`,
  ...extra,
});
const say = (id: string): WorkStep => ({
  id,
  kind: "say",
  text: `Progress ${id}`,
});
const exchange = (
  steps: readonly WorkStep[],
  extra: Partial<ChatExchange> = {},
): ChatExchange => ({
  id: "turn",
  prompt: "Check the change",
  status: "live",
  steps,
  answer: "",
  answerId: "message",
  ...extra,
});
function setup(value: ChatExchange) {
  const fixture = TestBed.createComponent(ChatComponent);
  const host: HTMLElement = fixture.nativeElement;
  document.body.append(host);
  const update = (next: ChatExchange) => {
    fixture.componentRef.setInput("exchanges", [next]);
    fixture.detectChanges();
  };
  update(value);
  return { fixture, host, update };
}
function head(host: HTMLElement, id: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    `[data-work-step="${id}"] ex-tool-step .head`,
  )!;
}
const visible = (host: HTMLElement, id: string): boolean =>
  !head(host, id).closest(".step-fold")?.hasAttribute("inert");
function group(host: HTMLElement, id: string): HTMLButtonElement | null {
  const control = host.querySelector<HTMLButtonElement>(
    `[data-work-step="${id}"] .group`,
  );
  return control?.closest(".group-fold")?.hasAttribute("inert")
    ? null
    : control;
}
async function settle(fixture: ComponentFixture<ChatComponent>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}
afterEach(() => {
  TestBed.resetTestingModule();
  document.querySelectorAll("ex-chat").forEach((e) => e.remove());
});

describe("message-delimited work sections", () => {
  it("keeps up to ten active tools visible, then keeps five recent tools in that section", () => {
    const steps = Array.from({ length: 10 }, (_, n) => tool(`command-${n}`));
    const { host, update } = setup(exchange(steps));
    expect(group(host, "command-0")).toBeNull();
    expect(visible(host, "command-0")).toBe(true);
    update(exchange([...steps, tool("command-10")]));
    expect(group(host, "command-0")?.textContent).toContain("6 commands");
    // The visible recent window is not the summary's contents: say so.
    expect(group(host, "command-0")?.textContent).toContain("Earlier");
    expect(group(host, "command-0")?.getAttribute("aria-label")).toBe(
      "Show earlier activity: 6 commands",
    );
    expect(visible(host, "command-5")).toBe(false);
    expect(visible(host, "command-6")).toBe(true);
    expect(visible(host, "command-10")).toBe(true);
  });

  it("collapses each section where it occurred, keeping every message visible in completed history", () => {
    const { host } = setup(
      exchange(
        [
          say("intro"),
          tool("read", { kind: "read" }),
          tool("command"),
          say("progress"),
          tool("edit", { kind: "edit" }),
        ],
        { answer: "Done.", status: "done" },
      ),
    );
    expect(group(host, "read")?.getAttribute("aria-label")).toContain(
      "1 read · 1 command",
    );
    expect(group(host, "edit")?.textContent).toContain("1 edit");
    expect(group(host, "edit")?.textContent).not.toContain("Earlier");
    expect(visible(host, "read")).toBe(false);
    expect(visible(host, "edit")).toBe(false);
    const text = [...host.querySelectorAll(".prose, .answer")].map((e) =>
      e.textContent?.trim(),
    );
    expect(text).toEqual(["Progress intro", "Progress progress", "Done."]);
    const order = [...host.querySelectorAll("[data-work-step]")].map((e) =>
      e.getAttribute("data-work-step"),
    );
    expect(order).toEqual([
      "intro",
      "read",
      "command",
      "progress",
      "edit",
      "message",
    ]);
  });

  it("starts a fresh budget after a message and folds a single completed tool as the next message arrives", () => {
    const { host, update } = setup(
      exchange([tool("first")], {
        answerBeforeStepId: "first",
        answer: "Starting.",
      }),
    );
    expect(visible(host, "first")).toBe(true);
    update(
      exchange([say("message"), tool("first"), say("next"), tool("second")], {
        answerId: "latest",
      }),
    );
    expect(group(host, "first")?.textContent).toContain("1 command");
    expect(visible(host, "first")).toBe(false);
    expect(visible(host, "second")).toBe(true);
    expect(group(host, "second")).toBeNull();
  });

  it("does not collapse an active section for an empty streaming message", () => {
    const { host } = setup(
      exchange([
        tool("first"),
        { id: "empty", kind: "say", text: " " },
        tool("second"),
      ]),
    );
    expect(visible(host, "first")).toBe(true);
    expect(visible(host, "second")).toBe(true);
    expect(group(host, "first")).toBeNull();
    expect(
      [...host.querySelectorAll("[data-work-step]")].map((e) =>
        e.getAttribute("data-work-step"),
      ),
    ).toEqual(["first", "empty", "second", "message"]);
  });

  it.each(["live", "done", "failed", "stopped"] as const)(
    "folds failed calls into the section while keeping unfinished work visible in a %s turn",
    (status) => {
      const { host } = setup(
        exchange(
          [
            tool("running", { status: "running" }),
            tool("failed", { status: "failed" }),
            tool("unknown", { status: "unknown" }),
            tool("done"),
          ],
          { answer: "Another update.", status },
        ),
      );
      for (const id of ["running", "unknown"])
        expect(visible(host, id)).toBe(true);
      expect(visible(host, "done")).toBe(false);
      expect(visible(host, "failed")).toBe(false);
      expect(group(host, "running")?.getAttribute("aria-label")).toContain(
        "1 failed · 2 commands",
      );
    },
  );

  it("keeps a failure-only summary visible and exposes error details through the same keyboard disclosure", async () => {
    const failed = tool("failed", {
      status: "failed",
      output: "Database unavailable",
    });
    const { host, fixture, update } = setup(
      exchange([failed], { answer: "The database check failed." }),
    );
    const control = group(host, "failed")!;
    expect(control.getAttribute("aria-label")).toContain(
      "1 failed · 1 command",
    );
    expect(control.querySelector(".failure ex-status-glyph")).not.toBeNull();
    expect(visible(host, "failed")).toBe(false);
    control.focus();
    control.click();
    await settle(fixture);
    const button = head(host, "failed");
    button.click();
    button.focus();
    await settle(fixture);
    expect(host.querySelector("pre")?.textContent).toContain(
      "Database unavailable",
    );
    update(
      exchange([failed], {
        status: "done",
        answer: "The database check failed.",
      }),
    );
    await settle(fixture);
    expect(head(host, "failed")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    control.focus();
    control.click();
    await settle(fixture);
    expect(visible(host, "failed")).toBe(false);
    expect(document.activeElement).toBe(control);
    expect(control.querySelector(".failure")?.textContent).toContain(
      "1 failed",
    );
  });

  it("retains a failure marker through later success and clears it only after explicit recovery", () => {
    const failed = tool("failed", { status: "failed" });
    const { host, update } = setup(exchange([failed], { answer: "Checking." }));
    update(
      exchange([failed, tool("success")], { answer: "Another check passed." }),
    );
    expect(
      group(host, "failed")?.querySelector(".failure")?.textContent,
    ).toContain("1 failed");
    update(
      exchange([{ ...failed, recovered: true }, tool("success")], {
        answer: "Recovered.",
      }),
    );
    expect(group(host, "failed")?.querySelector(".failure")).toBeNull();
    expect(visible(host, "failed")).toBe(false);
  });

  it("includes an older failed attempt in active-section compaction", () => {
    const steps = [
      tool("failed", { status: "failed" }),
      ...Array.from({ length: 10 }, (_, n) => tool(`command-${n}`)),
    ];
    const { host } = setup(exchange(steps));
    expect(visible(host, "failed")).toBe(false);
    expect(visible(host, "command-9")).toBe(true);
    expect(group(host, "failed")?.getAttribute("aria-label")).toContain(
      "1 failed · 6 commands",
    );
  });

  it("retains an inspected tool and focus through new messages, completion, and explicit section collapse", async () => {
    const first = exchange([tool("command")], {
      answerBeforeStepId: "command",
      answer: "Checking.",
    });
    const { host, fixture, update } = setup(first);
    const button = head(host, "command");
    button.click();
    button.focus();
    await settle(fixture);
    update(
      exchange([say("message"), tool("command")], {
        answerId: "next",
        answer: "Done.",
        status: "done",
      }),
    );
    await settle(fixture);
    expect(head(host, "command")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(visible(host, "command")).toBe(true);
    const control = group(host, "command")!;
    control.focus();
    control.click();
    await settle(fixture);
    expect(control.getAttribute("aria-expanded")).toBe("true");
    control.click();
    await settle(fixture);
    expect(visible(host, "command")).toBe(false);
    expect(document.activeElement).toBe(control);
    control.click();
    await settle(fixture);
    expect(visible(host, "command")).toBe(true);
    expect(head(host, "command")).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("retains explicit section expansion through incoming tools and messages without opening other sections", async () => {
    const steps = Array.from({ length: 11 }, (_, n) => tool(`command-${n}`));
    const { host, fixture, update } = setup(exchange(steps));
    const control = group(host, "command-0")!;
    control.focus();
    control.click();
    await settle(fixture);
    update(
      exchange([...steps, say("update"), tool("later")], {
        status: "done",
        answer: "Done.",
      }),
    );
    await settle(fixture);
    expect(group(host, "command-0")).toBe(control);
    expect(visible(host, "command-0")).toBe(true);
    expect(visible(host, "later")).toBe(false);
    expect(document.activeElement).toBe(control);
    control.click();
    control.click();
    control.click();
    await settle(fixture);
    expect(visible(host, "command-0")).toBe(false);
    expect(document.activeElement).toBe(control);
    expect(host.querySelectorAll("ex-work-timeline")).toHaveLength(1);
  });

  it("expands all sections from the work line and collapses tools while retaining every message", async () => {
    const { host, fixture } = setup(
      exchange([say("intro"), tool("first"), say("progress"), tool("last")], {
        status: "done",
        answer: "Done.",
      }),
    );
    const work = host.querySelector<HTMLButtonElement>(".work")!;
    work.click();
    await settle(fixture);
    expect(visible(host, "first")).toBe(true);
    expect(visible(host, "last")).toBe(true);
    work.click();
    await settle(fixture);
    expect(visible(host, "first")).toBe(false);
    expect(visible(host, "last")).toBe(false);
    expect(host.querySelectorAll(".prose, .answer")).toHaveLength(3);
  });

  it("retains Markdown controls and their intents when the latest reply becomes commentary", async () => {
    const text =
      "Read [the docs](https://example.com/docs).\n\n```ts\nconst retry = true;\n```";
    const { host, fixture, update } = setup(
      exchange([tool("command")], { answer: text }),
    );
    const copied: string[] = [],
      links: string[] = [];
    fixture.componentInstance.copyCode.subscribe((value) => copied.push(value));
    fixture.componentInstance.openLink.subscribe((value) => links.push(value));
    const copy = host.querySelector<HTMLButtonElement>(
      '[aria-label="Copy code"]',
    )!;
    copy.focus();
    update(
      exchange([tool("command"), { id: "message", kind: "say", text }], {
        answerId: "next",
        answer: "Done.",
        status: "done",
      }),
    );
    await settle(fixture);
    expect(host.querySelector('[aria-label="Copy code"]')).toBe(copy);
    expect(document.activeElement).toBe(copy);
    expect(copy.closest(".step-fold")?.hasAttribute("inert")).toBe(false);
    copy.click();
    host
      .querySelector<HTMLButtonElement>(".prose ex-markdown-inline button")!
      .click();
    expect(copied).toEqual(["const retry = true;"]);
    expect(links).toEqual(["https://example.com/docs"]);
  });
});
