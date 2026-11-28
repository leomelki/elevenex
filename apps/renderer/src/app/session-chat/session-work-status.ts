import type { SessionChatWorkStatus } from "@elevenex/shared";
import type { Status } from "../ui";

const states: Readonly<
  Record<SessionChatWorkStatus, { label: string; tone: Status }>
> = {
  pending: { label: "Starting", tone: "queued" },
  running: { label: "Running", tone: "running" },
  waiting: { label: "Needs input", tone: "attention" },
  paused: { label: "Paused", tone: "queued" },
  completed: { label: "Finished", tone: "done" },
  interrupted: { label: "Interrupted", tone: "attention" },
  stopped: { label: "Stopped", tone: "done" },
  error: { label: "Failed", tone: "failed" },
  closed: { label: "Closed", tone: "done" },
  unavailable: { label: "Unavailable", tone: "attention" },
};
export const sessionWorkStatus = (status: SessionChatWorkStatus = "running") =>
  states[status];
