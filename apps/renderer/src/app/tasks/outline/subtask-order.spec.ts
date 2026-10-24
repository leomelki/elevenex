import { describe, expect, it } from "vitest";
import { subtaskLocations } from "./subtask-order";

describe("sub-task ancestry", () => {
  it("keeps siblings stable and flattens depth without losing the parent path", () => {
    const locations = subtaskLocations([
      { id: "child", title: "Child", parent: "parent" },
      { id: "sibling", title: "Sibling" },
      { id: "parent", title: "Parent" },
      { id: "deep", title: "Deep", parent: "child" },
    ]);
    expect(locations.map((location) => location.subtask.id)).toEqual([
      "sibling",
      "parent",
      "child",
      "deep",
    ]);
    expect(locations.at(-1)?.parents.map((parent) => parent.id)).toEqual([
      "parent",
      "child",
    ]);
  });
  it("promotes children of merged parents and tolerates a supplied cycle", () => {
    const locations = subtaskLocations([
      { id: "merged", title: "Merged", merged: true },
      { id: "child", title: "Child", parent: "merged" },
      { id: "a", title: "A", parent: "b" },
      { id: "b", title: "B", parent: "a" },
    ]);
    expect(locations.map((location) => location.subtask.id)).toEqual([
      "child",
      "a",
      "b",
    ]);
    expect(locations[0]?.parents).toEqual([]);
  });
});
