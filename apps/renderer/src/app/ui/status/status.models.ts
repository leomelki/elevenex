export type Status =
  | "running"
  | "attention"
  | "review"
  | "done"
  | "failed"
  | "queued";
export const STATUS_LABELS: Readonly<Record<Status, string>> = {
  running: "Running",
  attention: "Needs you",
  review: "New reply",
  done: "Done",
  failed: "Failed",
  queued: "Queued",
};
