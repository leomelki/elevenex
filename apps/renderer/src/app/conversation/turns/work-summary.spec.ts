import { describe, expect, it } from "vitest";
import { formatDuration, groupWorkSteps, summarizeWork } from "./work-summary";

describe("work timeline grouping", () => {
  it("groups adjacent discoveries while preserving failure evidence and stable keys", () => {
    const groups = groupWorkSteps([
      { id: "a", kind: "read", status: "done" },
      { id: "b", kind: "search", status: "done" },
      { id: "c", kind: "list", status: "done" },
      { id: "d", kind: "run", status: "failed" },
      { id: "e", kind: "read", status: "done" },
    ]);
    expect(groups.map((group) => group.id)).toEqual(["a", "d", "e"]);
    expect(groups[0]?.kind).toBe("group");
    expect(groups[1]?.kind === "run" && groups[1].status).toBe("failed");
  });
  it("formats durations without negative or nonfinite values", () => {
    expect(formatDuration(252.8)).toBe("4m 12s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
  it("keeps at most four facts, prioritizes failures and reports the latest tests", () => {
    expect(
      summarizeWork(
        [
          { id: "read", kind: "read" },
          { id: "old", kind: "test", result: "10/10 passed" },
          { id: "fixed", kind: "run", status: "failed", recovered: true },
          {
            id: "repro",
            kind: "test",
            status: "failed",
            expected: true,
            result: "Expected failure",
          },
          { id: "latest", kind: "test", result: "200/200 passed" },
          { id: "error", kind: "run", status: "failed" },
        ],
        [{ path: "retry.ts", add: 92, del: 12 }],
      ),
    ).toEqual([
      { kind: "failure", label: "1 failed" },
      { kind: "files", label: "Edited 1 file +92 −12" },
      { kind: "tests", label: "200/200 passed" },
      { kind: "commands", label: "Ran 2 commands" },
    ]);
  });
  it("describes grouped discovery in verbs and omits empty categories", () => {
    const entries = groupWorkSteps([
      { id: "a", kind: "read" },
      { id: "b", kind: "read" },
      { id: "c", kind: "search" },
    ]);
    expect(entries[0]?.kind === "group" && entries[0].label).toBe(
      "Read 2 files · Searched 1 time",
    );
  });
});
