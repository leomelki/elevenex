import type {
  ChangedFile,
  TimelineEntry,
  WorkStep,
  DeferredTurnWork,
} from "../conversation.models";
export interface WorkFact {
  readonly kind:
    | "failure" | "files" | "tests" | "commands" | "reads"
    | "edits" | "searches" | "lists" | "web" | "tools" | "questions" | "agents";
  readonly label: string;
  readonly icon:
    | "x" | "changes" | "check" | "terminal"
    | "file" | "search" | "globe" | "plug" | "chat" | "subtask";
  readonly tone?: "ok" | "danger";
  readonly diff?: { readonly add: number; readonly del: number };
}
/** Keep glanceable evidence bounded; details remain in the work timeline. */
export function summarizeWork(
  steps: readonly WorkStep[],
  files: readonly ChangedFile[],
  fileCount = files.length,
  saved?: Pick<DeferredTurnWork, 'counts' | 'failures'>,
  sharedChanges = false,
  totals?: WorkFact['diff'],
  agents = 0,
): readonly WorkFact[] {
  let failures = saved?.failures ?? 0;
  const counts: Partial<Record<WorkStep['kind'], number>> = { ...saved?.counts };
  let testResult = "";
  let testFailed = false;
  for (const step of saved ? [] : steps) {
    if (step.status === "failed" && !step.recovered && !step.expected)
      failures++;
    if (!step.agentBoard) counts[step.kind] = (counts[step.kind] ?? 0) + 1;
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
  const { run: commands = 0, read: reads = 0, search: searches = 0,
    list: lists = 0, web = 0, tool: tools = 0, ask: questions = 0 } = counts;
  const edits = (counts.edit ?? 0) + (counts.create ?? 0);
  const facts: WorkFact[] = [];
  if (failures)
    facts.push({
      kind: "failure",
      label: `${failures} failed`,
      icon: "x",
      tone: "danger",
    });
  if (agents)
    facts.push({ kind: 'agents', label: agents + (agents === 1 ? ' agent' : ' agents'), icon: 'subtask' });
  if (files.length) {
    const diff = totals ?? (fileCount === files.length ? {
      add: files.reduce((sum, file) => sum + (file.add ?? 0), 0),
      del: files.reduce((sum, file) => sum + (file.del ?? 0), 0),
    } : undefined);
    facts.push({
      kind: "files",
      label: sharedChanges
        ? `${fileCount} workspace ${fileCount === 1 ? "change" : "changes"}`
        : `Edited ${fileCount} ${fileCount === 1 ? "file" : "files"}`,
      icon: "changes",
      diff,
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
      label: `${commands} ${commands === 1 ? "command" : "commands"}`,
    });
  if (reads)
    facts.push({
      kind: "reads",
      icon: "file",
      label: `${reads} ${reads === 1 ? "read" : "reads"}`,
    });
  if (edits && (sharedChanges || !files.length))
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
  if (questions)
    facts.push({
      kind: "questions", icon: "chat",
      label: `${questions} ${questions === 1 ? "question" : "questions"}`,
    });
  return facts.slice(0, 4);
}
export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return value >= 3600
    ? `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`
    : value >= 60
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
      (step.status === undefined || step.status === "done")
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
    media: "Previewed",
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
    media: "Previewing",
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
