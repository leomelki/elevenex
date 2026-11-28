import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { signal } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComponent } from "../chat/chat.component";
import type { ChatExchange, WorkStep } from "../conversation.models";
import type { ToolDetailsProvider, ToolDetailsState } from "../tool-presentation";

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
    `[data-work-section="${id}"] .group`,
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
  it("restores saved sections and only requests details for tools whose bodies were open", async () => {
    const source = (id: string) => ({ item: { id, revision: 'a'.repeat(64) } });
    const loaded = [say('intro'), tool('opened', { deferredTool: source('opened') }),
      tool('closed', { deferredTool: source('closed') }), say('after')];
    const base = { answer: 'Final reply', status: 'done' as const };
    const work = { counts: { run: 2 }, failures: 0, busy: false, ready: false };
    const { host, fixture, update } = setup(exchange([], { ...base, deferredWork: work }));
    const toggled = vi.fn();
    fixture.componentInstance.turnWorkToggled.subscribe(toggled);
    const state = signal<ToolDetailsState>({ status: 'ready', evidence: {
      presentation: { summary: 'opened', blocks: [{ kind: 'text', text: 'Saved evidence' }] },
      output: '',
    } });
    const inspect = vi.fn<ToolDetailsProvider>(() => ({ state, retry: () => undefined }));
    fixture.componentRef.setInput('inspectTool', inspect);
    const worked = host.querySelector<HTMLButtonElement>('button.work')!;
    const reply = host.querySelector('.answer');
    worked.click();
    update(exchange([], { ...base, deferredWork: { ...work, busy: true } }));
    expect(host.querySelector('[data-work-step="intro"]')).toBeNull();
    expect(host.querySelector('ex-turn-work-panel .surface')).toBeNull();
    update(exchange(loaded, { ...base, deferredWork: { ...work, ready: true } }));
    expect(host.querySelector('.answer')).toBe(reply);
    expect(host.querySelector('ex-tool-step')).toBeNull();
    group(host, 'opened')!.click();
    await settle(fixture);
    expect(inspect).not.toHaveBeenCalled();
    head(host, 'opened').click();
    await settle(fixture);
    expect(host.querySelector('.tool-preview')?.textContent).toContain('Saved evidence');
    worked.click();
    update(exchange([], { ...base, deferredWork: work }));
    expect(inspect.mock.calls[0]![1].aborted).toBe(true);
    expect(host.querySelector('ex-tool-step')).toBeNull();

    worked.focus();
    worked.click();
    await settle(fixture);
    expect(toggled).toHaveBeenLastCalledWith({ id: 'turn', open: true, toolIds: ['opened'] });
    update(exchange(loaded, { ...base, deferredWork: { ...work, ready: true } }));
    await settle(fixture);
    expect(group(host, 'opened')?.getAttribute('aria-expanded')).toBe('true');
    expect(head(host, 'opened').getAttribute('aria-expanded')).toBe('true');
    expect(head(host, 'closed').getAttribute('aria-expanded')).toBe('false');
    expect(inspect.mock.calls.map(([source]) => source.item.id)).toEqual(['opened', 'opened']);
    expect(host.querySelector('.answer')).toBe(reply);
    expect(document.activeElement).toBe(worked);
  });

  it("keeps the last actual message when a settled receipt has no separate answer", async () => {
    const { host, fixture, update } = setup(exchange([
      say("intro"), tool("command"), say("last"),
    ]));
    update(exchange([say("intro"), tool("command"), say("last")], { status: "done" }));
    await settle(fixture);
    expect(host.querySelector('[data-work-step="intro"] .step-fold')?.hasAttribute("inert")).toBe(true);
    expect(host.querySelector('[data-work-step="last"] .step-fold')?.hasAttribute("inert")).toBe(false);
    expect(visible(host, "command")).toBe(false);
  });

  it("starts Earlier with one tool beyond the five recent tools and grows it one call at a time", () => {
    const steps = Array.from({ length: 11 }, (_, n) => tool(`command-${n}`));
    const { host, update } = setup(exchange(steps.slice(0, 5)));
    expect(group(host, "command-0")).toBeNull();
    expect(visible(host, "command-0")).toBe(true);
    for (let count = 6; count <= steps.length; count++) {
      update(exchange(steps.slice(0, count)));
      const earlier = count - 5;
      expect(group(host, "command-0")?.textContent).toContain("Earlier");
      expect(group(host, "command-0")?.getAttribute("aria-label")).toBe(
        `Show earlier activity: ${earlier} ${earlier === 1 ? "command" : "commands"}`,
      );
      for (let index = 0; index < count; index++)
        expect(visible(host, `command-${index}`)).toBe(index >= earlier);
    }
  });

  it("keeps the collapsed summary mounted when live updates evict its oldest tools", async () => {
    const older = Array.from({ length: 8 }, (_, n) => tool(`old-${n}`));
    const later = [say("progress"), tool("running", { status: "running" })];
    const { host, fixture, update } = setup(exchange([...older, ...later]));
    const summary = group(host, "old-0")!;
    const running = head(host, "running");
    summary.focus();

    for (let trim = 1; trim <= 3; trim++) {
      update(exchange([...older.slice(trim), ...later, tool(`recent-${trim}`)]));
      await settle(fixture);
      expect(group(host, `old-${trim}`)).toBe(summary);
      expect(summary.getAttribute("aria-expanded")).toBe("false");
      expect(summary.getAttribute("aria-label")).toBe(`Show activity: ${8 - trim} commands`);
      expect(document.activeElement).toBe(summary);
      expect(visible(host, `old-${trim}`)).toBe(false);
      expect(head(host, "running")).toBe(running);
    }

    summary.click();
    await settle(fixture);
    expect(visible(host, "old-3")).toBe(true);
  });

  it("collapses each section where it occurred, hiding earlier messages in completed history", () => {
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
    expect(group(host, "read")).toBeNull();
    expect(group(host, "edit")).toBeNull();
    for (const id of ["intro", "progress"])
      expect(host.querySelector(`[data-work-step="${id}"] .step-fold`)?.hasAttribute("inert")).toBe(true);
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

  it('updates an in-flight patch in place after commentary closed its section', () => {
    const patch = tool('patch', { kind: 'edit', status: 'running' });
    const { host, update } = setup(exchange([patch], { answer: 'Checking the edit.' }));
    const control = head(host, patch.id);
    expect(visible(host, patch.id)).toBe(true);

    update(exchange([{ ...patch, status: 'done' }], { answer: 'Checking the edit.' }));
    expect(visible(host, patch.id)).toBe(true);
    expect(head(host, patch.id)).toBe(control);
    expect([...host.querySelectorAll('[data-work-step]')].map(row => row.getAttribute('data-work-step')))
      .toEqual(['patch', 'message']);

    update(exchange([{ ...patch, status: 'done' }, say('message')], { answer: 'Checks passed.', answerId: 'next' }));
    expect(visible(host, patch.id)).toBe(false);
    expect(group(host, patch.id)?.getAttribute('aria-label')).toContain('1 edit');
    expect(head(host, patch.id)).toBe(control);
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
        expect(visible(host, id)).toBe(status === "live");
      expect(visible(host, "done")).toBe(false);
      expect(visible(host, "failed")).toBe(false);
      if (status === "live")
        expect(group(host, "running")?.getAttribute("aria-label")).toContain("1 failed · 2 commands");
      else expect(group(host, "running")).toBeNull();
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

  it("keeps a section and its inspected tool open when an older page extends the section", async () => {
    const steps = [tool("first"), tool("inspected")];
    const done = { status: "done", answer: "Done." } as const;
    const { host, fixture, update } = setup(exchange(steps, done));
    host.querySelector<HTMLButtonElement>(".work")!.click();
    await settle(fixture);
    group(host, "first")!.click();
    await settle(fixture);
    const button = head(host, "inspected");
    button.click();
    button.focus();
    update(exchange([tool("older"), ...steps], done));
    await settle(fixture);
    expect(group(host, "older")?.getAttribute("aria-expanded")).toBe("true");
    expect(visible(host, "first")).toBe(true);
    expect(head(host, "inspected")).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("keeps activity visible when the turn being read finishes", async () => {
    const steps = [say("reading"), tool("command")];
    const { host, fixture, update } = setup(exchange(steps));
    fixture.componentInstance.active.set("turn");
    fixture.componentInstance.scroll()?.atEnd.set(false);
    update(exchange(steps, { status: "done", answer: "Done." }));
    await settle(fixture);
    expect(host.querySelector(".work")?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-work-step="reading"] .step-fold')?.hasAttribute("inert")).toBe(false);
    host.querySelector<HTMLButtonElement>(".work")!.click();
    await settle(fixture);
    expect(host.querySelector('[data-work-step="reading"] .step-fold')?.hasAttribute("inert")).toBe(true);
  });

  it("reveals messages and section summaries without expanding tool disclosures", async () => {
    const { host, fixture } = setup(
      exchange([say("intro"), tool("first"), say("progress"), tool("last")], {
        status: "done",
        answer: "Done.",
      }),
    );
    const work = host.querySelector<HTMLButtonElement>(".work")!;
    work.click();
    await settle(fixture);
    expect(visible(host, "first")).toBe(false);
    expect(visible(host, "last")).toBe(false);
    expect(group(host, "first")).not.toBeNull();
    expect(host.querySelector('[data-work-step="intro"] .step-fold')?.hasAttribute("inert")).toBe(false);
    group(host, "first")!.click();
    await settle(fixture);
    expect(visible(host, "first")).toBe(true);
    expect(head(host, "first").getAttribute("aria-expanded")).toBe("false");
    work.click();
    await settle(fixture);
    expect(visible(host, "first")).toBe(false);
    expect(visible(host, "last")).toBe(false);
    expect(host.querySelectorAll(".prose, .answer")).toHaveLength(3);
  });

  it("keeps Worked closed when the visible answer receives focus or a click", async () => {
    const { host, fixture } = setup(exchange([tool("thought", { kind: "think" })], {
      answer: "Finished.\n\n```ts\nconst retry = true;\n```",
      status: "done",
    }));
    const work = host.querySelector<HTMLButtonElement>(".work")!;
    const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!;
    const copied: string[] = [];
    fixture.componentInstance.copyCode.subscribe(value => copied.push(value));
    copy.focus();
    copy.click();
    await settle(fixture);
    expect(work.getAttribute("aria-expanded")).toBe("false");
    expect(group(host, "thought")).toBeNull();
    expect(document.activeElement).toBe(copy);
    expect(copied).toEqual(["const retry = true;"]);
    work.click();
    await settle(fixture);
    expect(group(host, "thought")).not.toBeNull();
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
