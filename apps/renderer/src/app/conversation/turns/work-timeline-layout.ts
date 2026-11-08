import type { WorkGroup, WorkStep } from "../conversation.models";
import { groupWorkSteps, isProse } from "./work-summary";

export interface WorkTimelineRow {
  readonly step: WorkStep;
  readonly group?: WorkGroup;
}

/** Groups describe flat, keyed rows. A discovery never reparents a tool. */
export function workTimelineRows(
  steps: readonly WorkStep[],
): readonly WorkTimelineRow[] {
  return groupWorkSteps(steps).flatMap((entry) =>
    entry.kind === "group"
      ? entry.items.map((step) => ({ step, group: entry }))
      : [{ step: entry }],
  );
}

/** One turn-wide budget; commentary and unresolved work are never aged out. */
export function earlierWorkIds(
  rows: readonly WorkTimelineRow[],
  maxVisible: number,
): ReadonlySet<string> {
  const units = rows.filter(
    (row) => !isProse(row.step) && (!row.group || row.group.id === row.step.id),
  );
  const limit = Number.isFinite(maxVisible)
    ? Math.max(1, Math.floor(maxVisible))
    : 4;
  const earlier = units.slice(0, Math.max(0, units.length - limit));
  const ids = earlier.flatMap((row) => {
    const steps = row.group?.items ?? [row.step];
    return steps.some(
      (step) =>
        step.status === "running" ||
        step.status === "unknown" ||
        (step.status === "failed" && !step.recovered && !step.expected),
    )
      ? []
      : steps.map((step) => step.id);
  });
  return new Set(ids.length > 1 ? ids : []);
}
