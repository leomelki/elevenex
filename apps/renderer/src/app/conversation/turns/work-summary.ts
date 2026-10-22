import type { TimelineEntry, WorkStep } from "../conversation.models";
export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return value >= 60
    ? `${Math.floor(value / 60)}m ${value % 60}s`
    : `${value}s`;
}
export function isProse(step: WorkStep): boolean {
  return step.kind === "say" || step.kind === "note";
}
/** Collapse only adjacent successful discovery steps. Failures remain visible. */
export function groupWorkSteps(
  steps: readonly WorkStep[],
): readonly TimelineEntry[] {
  const groups: TimelineEntry[] = [];
  let pending: WorkStep[] = [];
  const flush = (): void => {
    if (pending.length >= 3)
      groups.push({
        id: pending[0]!.id,
        kind: "group",
        label: `${pending.filter((s) => s.kind === "read").length} reads · ${pending.filter((s) => s.kind === "search").length} searches · ${pending.filter((s) => s.kind === "list").length} listings`,
        items: pending,
      });
    else groups.push(...pending);
    pending = [];
  };
  for (const step of steps) {
    if (
      ["read", "search", "list"].includes(step.kind) &&
      step.status !== "failed" &&
      step.status !== "running"
    )
      pending.push(step);
    else {
      flush();
      groups.push(step);
    }
  }
  flush();
  return groups;
}
export function stepVerb(step: WorkStep, live = false): string {
  const past: Record<WorkStep["kind"], string> = {
    think: "Thought",
    read: "Read",
    search: "Searched",
    list: "Listed",
    edit: "Edited",
    create: "Created",
    run: "Ran",
    test: "Tested",
    tool: "Called",
    web: "Browsed",
    ask: "Asked",
    say: "Said",
    note: "Said",
  };
  const present: Record<WorkStep["kind"], string> = {
    think: "Thinking",
    read: "Reading",
    search: "Searching",
    list: "Listing",
    edit: "Editing",
    create: "Creating",
    run: "Running",
    test: "Testing",
    tool: "Calling",
    web: "Browsing",
    ask: "Asking",
    say: "Writing",
    note: "Writing",
  };
  return step.verb ?? (live ? present[step.kind] : past[step.kind]);
}
export function stepIcon(step: WorkStep): string {
  if (step.kind === "think") return "bulb";
  if (step.kind === "search") return "search";
  if (step.kind === "run" || step.kind === "test") return "terminal";
  if (step.kind === "edit" || step.kind === "create") return "changes";
  if (step.kind === "web") return "globe";
  if (step.kind === "tool") return "plug";
  return "file";
}
