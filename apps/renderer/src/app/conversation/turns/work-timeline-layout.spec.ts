import { describe, expect, it } from "vitest";
import type { WorkStep } from "../conversation.models";
import { workTimelineRows } from "./work-timeline-layout";

describe("activity summary evidence", () => {
  it("counts observed operations without inferring shell effects and includes failed attempts", () => {
    const steps: readonly WorkStep[] = [
      { id: "read", kind: "read" },
      { id: "command", kind: "run", detail: "cat file; echo changed > file" },
      { id: "edit", kind: "edit" },
      { id: "create", kind: "create" },
      { id: "search", kind: "search" },
      { id: "test", kind: "test" },
      { id: "failed", kind: "run", status: "failed" },
      { id: "unknown", kind: "tool", status: "unknown" },
      { id: "running", kind: "read", status: "running" },
      { id: "answer", kind: "say", text: "Done" },
    ];
    const section = workTimelineRows(steps)[0]!.section!;
    expect(section.label).toBe(
      "1 failed · 1 read · 2 commands · 2 edits · 1 search · 1 test run",
    );
    expect([...section.folded]).toEqual([
      "read",
      "command",
      "edit",
      "create",
      "search",
      "test",
      "failed",
    ]);
  });

  it("counts only unresolved failures as failed while folding all completed attempts", () => {
    const steps: readonly WorkStep[] = [
      { id: "repro", kind: "test", status: "failed", expected: true },
      { id: "fixed", kind: "run", status: "failed", recovered: true },
      { id: "failure", kind: "run", status: "failed" },
      { id: "success", kind: "run", status: "done" },
    ];
    expect([...workTimelineRows(steps)[0]!.section!.folded]).toEqual([
      "repro",
      "fixed",
      "failure",
      "success",
    ]);
    expect(
      workTimelineRows(steps)[0]!.section!.facts.filter((fact) => fact.danger),
    ).toEqual([
      { kind: "failure", count: 1, noun: "failed", icon: "x", danger: true },
    ]);
  });

  it("keeps section budgets independent and tolerates invalid recent-step limits", () => {
    const steps: readonly WorkStep[] = [
      ...Array.from(
        { length: 20 },
        (_, n): WorkStep => ({ id: `read-${n}`, kind: "read" }),
      ),
      { id: "message", kind: "say", text: "Another section." },
      { id: "last", kind: "run" },
    ];
    for (const limit of [NaN, Infinity, 0, -5, 2.8]) {
      const rows = workTimelineRows(steps, true, limit);
      expect(rows[0]!.section!.folded.size).toBe(20);
      expect(rows.at(-1)!.section!.folded.size).toBe(0);
      expect(rows.map((row) => row.step.id)).toEqual(
        steps.map((step) => step.id),
      );
    }
  });
});
