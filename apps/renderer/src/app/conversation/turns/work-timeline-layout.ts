import type { WorkStep } from "../conversation.models";
import { isProse } from "./work-summary";

export interface WorkSection {
  readonly id: string;
  readonly items: readonly WorkStep[];
  readonly folded: ReadonlySet<string>;
  readonly label: string;
}
export interface WorkTimelineRow {
  readonly step: WorkStep;
  readonly section?: WorkSection;
}

/** Unfinished work and unresolved failures must never disappear into a summary. */
export function needsAttention(step: WorkStep): boolean {
  return (
    step.status === "running" ||
    step.status === "unknown" ||
    (step.status === "failed" && !step.recovered && !step.expected)
  );
}

/**
 * Messages delimit activity sections. Keep one flat keyed list: a new message
 * can close a section without remounting an inspected tool or Markdown control.
 */
export function workTimelineRows(
  steps: readonly WorkStep[],
  live = false,
  maxVisible = 5,
  expanded = true,
): readonly WorkTimelineRow[] {
  const rows: WorkTimelineRow[] = [];
  const limit = Number.isFinite(maxVisible)
    ? Math.max(1, Math.floor(maxVisible))
    : 5;
  let pending: WorkStep[] = [];
  const flush = (closed: boolean): void => {
    const items = pending.filter((step) => !isProse(step));
    if (!items.length) {
      rows.push(...pending.map((step) => ({ step })));
      pending = [];
      return;
    }
    const candidates =
      closed || !expanded
        ? items
        : items.length > limit * 2
          ? items.slice(0, -limit)
          : [];
    const folded = candidates.filter((step) => !needsAttention(step));
    const section: WorkSection = {
      id: items[0]!.id,
      items,
      folded: new Set(folded.map((step) => step.id)),
      label: sectionSummary(folded),
    };
    rows.push(
      ...pending.map((step) => (isProse(step) ? { step } : { step, section })),
    );
    pending = [];
  };
  for (const step of steps) {
    if (isProse(step) && step.text?.trim()) {
      flush(true);
      rows.push({ step });
    } else {
      // An empty streaming reply is not a new message boundary yet.
      pending.push(step);
    }
  }
  flush(!live);
  return rows;
}

/** Counts describe observed tool operations, never inferred shell side effects. */
function sectionSummary(steps: readonly WorkStep[]): string {
  const counts = new Map<WorkStep["kind"], number>();
  for (const step of steps)
    counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  const labels: string[] = [];
  const add = (count: number, singular: string, plural = singular + "s") => {
    if (count) labels.push(`${count} ${count === 1 ? singular : plural}`);
  };
  const count = (kind: WorkStep["kind"]) => counts.get(kind) ?? 0;
  if (count("read"))
    labels.push(
      `Read ${count("read")} ${count("read") === 1 ? "file" : "files"}`,
    );
  if (count("run"))
    labels.push(
      `Ran ${count("run")} ${count("run") === 1 ? "command" : "commands"}`,
    );
  add(count("edit") + count("create"), "edit");
  add(count("search"), "search", "searches");
  add(count("list"), "folder listing");
  add(count("test"), "test run");
  add(count("web"), "web request");
  add(count("tool"), "tool call");
  add(count("ask"), "question");
  add(count("think"), "thought");
  return labels.join(" · ");
}
