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
const exchange = (
  steps: readonly WorkStep[],
  extra: Partial<ChatExchange> = {},
): ChatExchange => ({
  id: "turn",
  prompt: "Check the change",
  status: "live",
  steps,
  answer: "Checking the result.",
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
async function settle(fixture: ComponentFixture<ChatComponent>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}
afterEach(() => {
  TestBed.resetTestingModule();
  document.querySelectorAll("ex-chat").forEach((e) => e.remove());
});

describe("chronological work disclosures", () => {
  it('keeps an explicitly opened discovery group visible as later work arrives until Show fewer', async () => {
    const reads = [1, 2, 3].map(n => tool(`read-${n}`, { kind: 'read' }));
    const { host, fixture, update } = setup(exchange(reads));
    const group = host.querySelector<HTMLButtonElement>('.group')!;
    group.click(); host.querySelector<HTMLButtonElement>('.work')!.focus(); await settle(fixture);
    update(exchange([...reads, ...Array.from({ length: 8 }, (_, n) => tool(`command-${n}`))]));
    await settle(fixture);
    expect(visible(host, 'read-1')).toBe(true);
    const earlier = host.querySelector<HTMLButtonElement>('.earlier')!;
    earlier.focus(); earlier.click(); await settle(fixture);
    earlier.click(); await settle(fixture);
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(visible(host, 'read-1')).toBe(false);
    expect(document.activeElement).toBe(earlier);
  });
  it("retains an expanded tool and its focus when a new reply moves the answer boundary", async () => {
    const first = exchange([tool("command")], {
      answerBeforeStepId: "command",
    });
    const { host, fixture, update } = setup(first);
    const button = head(host, "command");
    button.click();
    button.focus();
    await settle(fixture);
    update(
      exchange(
        [{ id: "message", kind: "say", text: first.answer }, tool("command")],
        {
          answerId: "next-message",
          answer: "The check passed.",
        },
      ),
    );
    await settle(fixture);
    expect(head(host, "command")).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(host.querySelectorAll("ex-work-timeline")).toHaveLength(1);
    expect(
      host
        .querySelector('[data-work-step="message"]')!
        .compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps an inspected read mounted and open as discovery groups form and grow", async () => {
    const reads = [
      tool("read-1", { kind: "read" }),
      tool("read-2", { kind: "read" }),
    ];
    const { host, fixture, update } = setup(exchange(reads));
    const button = head(host, "read-1");
    button.click();
    button.focus();
    await settle(fixture);
    update(exchange([...reads, tool("read-3", { kind: "read" })]));
    expect(head(host, "read-1")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(visible(host, "read-1")).toBe(true);
    const group = host.querySelector<HTMLButtonElement>(".group")!;
    group.focus();
    group.click();
    await settle(fixture);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(visible(host, "read-1")).toBe(false);
    expect(document.activeElement).toBe(group);
    group.click();
    await settle(fixture);
    expect(visible(host, "read-1")).toBe(true);
    expect(head(host, "read-1")).toBe(button);
  });

  it("does not open a discovery group merely by focusing its control", async () => {
    const { host, fixture } = setup(
      exchange([1, 2, 3].map((n) => tool(`read-${n}`, { kind: "read" }))),
    );
    const group = host.querySelector<HTMLButtonElement>(".group")!;
    group.focus();
    await settle(fixture);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(visible(host, "read-1")).toBe(false);
  });

  it("keeps running, unknown and failed work visible outside the recent budget", () => {
    const steps = [
      tool("running", { status: "running" }),
      tool("failed", { status: "failed" }),
      tool("unknown", { status: "unknown" }),
      ...Array.from({ length: 8 }, (_, n) => tool(`done-${n}`)),
    ];
    const { host } = setup(exchange(steps));
    for (const id of ["running", "failed", "unknown"])
      expect(visible(host, id)).toBe(true);
    expect(visible(host, "done-0")).toBe(false);
    expect(host.querySelector(".earlier")?.textContent).toContain(
      "4 earlier steps",
    );
  });

  it("uses one budget around commentary and retains every progress message", () => {
    const steps = Array.from({ length: 3 }, (_, n) => [
      tool(`a-${n}`),
      tool(`b-${n}`),
      { id: `say-${n}`, kind: "say", text: `Progress ${n}` } satisfies WorkStep,
    ]).flat();
    const { host } = setup(exchange(steps, { answerBeforeStepId: "a-2" }));
    expect(host.querySelectorAll(".earlier")).toHaveLength(1);
    expect(host.querySelector(".earlier")?.textContent).toContain(
      "2 earlier steps",
    );
    for (let n = 0; n < 3; n++)
      expect(
        host
          .querySelector(`[data-work-step="say-${n}"] .step-fold`)
          ?.hasAttribute("inert"),
      ).toBe(false);
  });

  it("retains the earlier control and keyboard focus through repeated reveals and collapses", async () => {
    const { host, fixture } = setup(
      exchange(Array.from({ length: 8 }, (_, n) => tool(`tool-${n}`))),
    );
    const earlier = host.querySelector<HTMLButtonElement>(".earlier")!;
    earlier.focus();
    earlier.click();
    await settle(fixture);
    expect(earlier.getAttribute("aria-expanded")).toBe("true");
    expect(earlier.textContent).toContain("Show fewer steps");
    expect(visible(host, "tool-0")).toBe(true);
    earlier.click();
    await settle(fixture);
    expect(document.activeElement).toBe(earlier);
    expect(earlier.getAttribute("aria-expanded")).toBe("false");
    expect(visible(host, "tool-0")).toBe(false);
  });

  it("preserves an inspected result and focus through running-to-done completion", async () => {
    const { host, fixture, update } = setup(
      exchange([tool("command", { status: "running" })]),
    );
    const button = head(host, "command");
    button.click();
    button.focus();
    await settle(fixture);
    update(exchange([tool("command")], { status: "done" }));
    await settle(fixture);
    expect(head(host, "command")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(visible(host, "command")).toBe(true);
    expect(host.querySelector(".work")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("keeps explicit work expansion compact through completion and reopen", async () => {
    const steps = Array.from({ length: 20 }, (_, n) => tool(`tool-${n}`));
    const { host, fixture, update } = setup(exchange(steps));
    const work = host.querySelector<HTMLButtonElement>(".work")!;
    work.click();
    work.click();
    await settle(fixture);
    update(exchange(steps, { status: "done" }));
    await settle(fixture);
    expect(work.getAttribute("aria-expanded")).toBe("true");
    expect(visible(host, "tool-0")).toBe(false);
    expect(visible(host, "tool-19")).toBe(true);
    expect(host.querySelector(".earlier")?.textContent).toContain(
      "16 earlier steps",
    );
  });

  it("retains Markdown controls and forwards their intents when the latest reply becomes commentary", async () => {
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
    host.querySelector<HTMLButtonElement>(".work")!.click();
    fixture.detectChanges();
    copy.focus();
    update(
      exchange([tool("command"), { id: "message", kind: "say", text }], {
        answerId: "next",
        answer: "Done.",
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
