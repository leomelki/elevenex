import { describe, expect, it } from "vitest";
import { formatDuration, groupWorkSteps } from "./work-summary";

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
});
