import type {
  ChangedFile,
  TimelineEntry,
  WorkStep,
} from "../conversation.models";
export interface WorkFact {
  readonly kind:
    | "failure" | "files" | "tests" | "commands" | "reads"
    | "edits" | "searches" | "lists" | "web" | "tools";
  readonly label: string;
  readonly icon:
    | "x" | "changes" | "check" | "terminal"
    | "file" | "search" | "globe" | "plug";
  readonly tone?: "ok" | "danger";
  readonly diff?: { readonly add: number; readonly del: number };
}
/** Keep glanceable evidence bounded; details remain in the work timeline. */
export function summarizeWork(
  steps: readonly WorkStep[],
  files: readonly ChangedFile[],
): readonly WorkFact[] {
  let failures = 0;
  let commands = 0;
  let reads = 0;
  let edits = 0;
  let searches = 0;
  let lists = 0;
  let web = 0;
  let tools = 0;
  let testResult = "";
  let testFailed = false;
  for (const step of steps) {
    if (step.status === "failed" && !step.recovered && !step.expected)
      failures++;
    if (step.kind === "run") commands++;
    if (step.kind === "read") reads++;
    if (step.kind === "edit" || step.kind === "create") edits++;
    if (step.kind === "search") searches++;
    if (step.kind === "list") lists++;
    if (step.kind === "web") web++;
    if (step.kind === "tool") tools++;
    if (
      step.kind === "test" &&
      step.result &&
      !step.recovered &&
      !step.expected
    ) {
      testResult = step.result;
      testFailed = step.status === "failed";
    }
  }
  const facts: WorkFact[] = [];
  if (failures)
    facts.push({
      kind: "failure",
      label: `${failures} failed`,
      icon: "x",
      tone: "danger",
    });
  if (files.length) {
    const added = files.reduce((sum, file) => sum + (file.add ?? 0), 0);
    const removed = files.reduce((sum, file) => sum + (file.del ?? 0), 0);
    facts.push({
      kind: "files",
      label: `Edited ${files.length} ${files.length === 1 ? "file" : "files"}`,
      icon: "changes",
      diff: { add: added, del: removed },
    });
  }
  if (testResult)
    facts.push({
      kind: "tests",
      label: testResult,
      icon: testFailed ? "x" : "check",
      tone: testFailed ? "danger" : "ok",
    });
  if (commands)
    facts.push({
      kind: "commands",
      icon: "terminal",
      label: `Ran ${commands} ${commands === 1 ? "command" : "commands"}`,
    });
  if (reads)
    facts.push({
      kind: "reads",
      icon: "file",
      label: `Read ${reads} ${reads === 1 ? "file" : "files"}`,
    });
  if (edits && !files.length)
    facts.push({
      kind: "edits", icon: "changes",
      label: `${edits} ${edits === 1 ? "edit" : "edits"}`,
    });
  if (searches)
    facts.push({
      kind: "searches", icon: "search",
      label: `${searches} ${searches === 1 ? "search" : "searches"}`,
    });
  if (lists)
    facts.push({
      kind: "lists", icon: "file",
      label: `${lists} ${lists === 1 ? "listing" : "listings"}`,
    });
  if (web)
    facts.push({
      kind: "web", icon: "globe",
      label: `${web} web ${web === 1 ? "request" : "requests"}`,
    });
  if (tools)
    facts.push({
      kind: "tools", icon: "plug",
      label: `${tools} tool ${tools === 1 ? "call" : "calls"}`,
    });
  return facts.slice(0, 4);
}
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
        label: [
          {
            verb: "Read",
            noun: "file",
            count: pending.filter((s) => s.kind === "read").length,
          },
          {
            verb: "Searched",
            noun: "time",
            count: pending.filter((s) => s.kind === "search").length,
          },
          {
            verb: "Listed",
            noun: "folder",
            count: pending.filter((s) => s.kind === "list").length,
          },
        ]
          .filter(({ count }) => count > 0)
          .map(
            ({ verb, noun, count }) =>
              `${verb} ${count} ${noun}${count === 1 ? "" : "s"}`,
          )
          .join(" · "),
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
