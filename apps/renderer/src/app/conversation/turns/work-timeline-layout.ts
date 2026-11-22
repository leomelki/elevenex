import type { WorkStep } from "../conversation.models";
import { isProse } from "./work-summary";

interface SectionFact {
  readonly kind: WorkStep["kind"] | "failure";
  readonly count: number;
  readonly noun: string;
  readonly icon: string;
  readonly danger?: boolean;
}
export interface WorkSection {
  readonly id: string;
  readonly items: readonly WorkStep[];
  readonly folded: ReadonlySet<string>;
  readonly label: string;
  readonly facts: readonly SectionFact[];
  /** Only older steps are folded; the latest window stays visible below. */
  readonly earlier: boolean;
}
export interface WorkTimelineRow {
  readonly step: WorkStep;
  readonly section?: WorkSection;
}

/** Work without a completion receipt stays in its chronological row. */
export function isUnfinishedWork(step: WorkStep): boolean {
  return step.status === "running" || step.status === "unknown";
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
    const whole = closed || !expanded;
    const candidates = whole
      ? items
      : items.length > limit
        ? items.slice(0, -limit)
        : [];
    const folded = candidates.filter((step) => !isUnfinishedWork(step));
    const facts = sectionSummary(folded);
    const section: WorkSection = {
      id: items[0]!.id,
      items,
      folded: new Set(folded.map((step) => step.id)),
      label: facts.map((fact) => `${fact.count} ${fact.noun}`).join(" · "),
      facts,
      earlier: !whole && candidates.length > 0,
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
function sectionSummary(steps: readonly WorkStep[]): readonly SectionFact[] {
  const counts = new Map<WorkStep["kind"], number>();
  let failures = 0;
  for (const step of steps) {
    const count = step.kind === "media" ? step.media?.length ?? 0 : 1;
    counts.set(step.kind, (counts.get(step.kind) ?? 0) + count);
    if (step.status === "failed" && !step.recovered && !step.expected)
      failures++;
  }
  const facts: SectionFact[] = [];
  if (failures)
    facts.push({
      kind: "failure",
      count: failures,
      noun: "failed",
      icon: "x",
      danger: true,
    });
  const add = (
    kind: WorkStep["kind"],
    icon: string,
    singular: string,
    plural = singular + "s",
    count = counts.get(kind) ?? 0,
  ) => {
    if (count)
      facts.push({
        kind,
        count,
        noun: count === 1 ? singular : plural,
        icon,
      });
  };
  add("read", "file", "read");
  add("run", "terminal", "command");
  add(
    "edit",
    "changes",
    "edit",
    "edits",
    (counts.get("edit") ?? 0) + (counts.get("create") ?? 0),
  );
  add("search", "search", "search", "searches");
  add("list", "folder", "listing");
  add("test", "terminal", "test run");
  add("web", "globe", "web request");
  add("tool", "plug", "tool call");
  add("media", "file", "preview");
  add("ask", "chat", "question");
  add("think", "bulb", "thought");
  return facts;
}
