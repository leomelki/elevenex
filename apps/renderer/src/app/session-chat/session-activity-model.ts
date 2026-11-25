import type {
  DelegatedSessionWork,
  SessionAgentReference,
  SessionChatBackgroundWork,
  SessionChatWork,
  SessionChatWorkEvent,
} from "@elevenex/shared";
import { agentIdentity, agentWorkLive, sessionAgentTitle } from '../conversation';
import type { Status } from "../ui";
import { sessionWorkStatus } from "./session-work-status";

/**
 * Presentation model for the Activity panel. Pure functions turn the bounded
 * `SessionChatWork` projection into rows that lead with status, keep time in one
 * column and colour only what needs a person. Components render these views and
 * own interaction; nothing here touches the platform.
 */

/** A short, coloured qualifier shown before a row's summary. */
export interface ActivityTag {
  readonly text: string;
  readonly tone: "attention" | "neutral";
  /** Explains the tag to assistive technology and on hover. */
  readonly hint: string;
}

export interface WorkRowView {
  readonly item: SessionChatBackgroundWork;
  readonly title: string;
  /** Agent nickname, or a legacy harness role, shown quietly beside the title. */
  readonly identity: string;
  readonly glyph: Status;
  /** Announced with the row, since the glyph is decorative. */
  readonly statusLabel: string;
  readonly tag: ActivityTag | null;
  readonly summary: string;
  readonly startedAt: number | null;
  readonly inspectable: boolean;
  readonly hasControls: boolean;
  readonly session?: SessionAgentReference;
}

export interface ActivitySections {
  /** Work waiting on a decision; the backend already orders it first. */
  readonly needsYou: readonly WorkRowView[];
  readonly running: readonly WorkRowView[];
}

export interface EventRowView {
  readonly event: SessionChatWorkEvent;
  readonly icon: string;
  readonly at: number | null;
  /** Failure output keeps its lines in a code block instead of prose. */
  readonly output: boolean;
  /** Output long enough to clamp behind Show more. */
  readonly long: boolean;
  readonly session?: SessionAgentReference;
}

const LEFT_BEHIND: ActivityTag = {
  text: "Left behind",
  tone: "attention",
  hint: "The work that launched it has finished. It keeps running until stopped.",
};
const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const OUTPUT_PREVIEW_CHARS = 180;
const OUTPUT_PREVIEW_LINES = 4;

export function parseTime(value: string | null): number | null {
  const parsed = value === null ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatAgo(ms: number): string {
  if (ms < 45_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Reported consumption, such as “18.4k tokens · 9 tools”; empty when unreported. */
export function formatUsage(item: Pick<SessionChatBackgroundWork, 'tokens' | 'toolUses'>): string {
  return [
    item.tokens === undefined
      ? ""
      : `${compactNumber.format(item.tokens).toLowerCase()} tokens`,
    item.toolUses === undefined
      ? ""
      : `${item.toolUses} ${item.toolUses === 1 ? "tool" : "tools"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function workRowView(item: SessionChatBackgroundWork): WorkRowView {
  const title = item.title || item.label;
  const status = item.status ?? "running";
  const described = sessionWorkStatus(status);
  // Running and waiting are carried by the glyph and the section; other live
  // states (starting, paused) are rare enough to name.
  const tag = item.orphaned
    ? LEFT_BEHIND
    : status === "running" || status === "waiting"
      ? null
      : { text: described.label, tone: "neutral" as const, hint: "" };
  return {
    item,
    title,
    identity: item.title ? (item.agentName ?? item.role ?? "") : "",
    glyph: described.tone,
    statusLabel: item.orphaned
      ? `${described.label}, left behind`
      : described.label,
    tag,
    summary:
      (item.detail === title ? "" : item.detail) ||
      (status === "waiting" ? "Waiting for your decision" : ""),
    startedAt: parseTime(item.startedAt),
    inspectable: !!(item.inspectable && item.agentId),
    hasControls: item.stoppable || !!item.canBackground,
  };
}

export function activitySections(work: SessionChatWork): ActivitySections {
  const native = work.running.map(workRowView);
  const separate = (work.sessions ?? []).filter(item => agentWorkLive(item.status)).map(sessionWorkRow);
  const rows = [...native, ...separate];
  const needsYou = rows.filter(row => row.item.status === 'waiting').slice(0, 16);
  return {
    needsYou,
    running: rows.filter(row => row.item.status !== 'waiting').slice(0, 16 - needsYou.length),
  };
}

function sessionWorkRow(work: DelegatedSessionWork): WorkRowView {
  const title = sessionAgentTitle(work.session);
  return {
    ...workRowView({
      id: 'session:' + work.session.sessionId, kind: 'agent', title, label: title,
      detail: work.detail, status: work.status, startedAt: work.startedAt,
      stoppable: false, orphaned: false,
    }),
    inspectable: true,
    session: work.session,
    identity: agentIdentity(work.session.selection),
  };
}

export function recentActivity(work: SessionChatWork): readonly EventRowView[] {
  const recent = work.recent.map(eventRowView);
  for (const agent of work.sessions ?? []) {
    if (agentWorkLive(agent.status)) continue;
    const status = sessionWorkStatus(agent.status);
    const event: SessionChatWorkEvent = {
      id: 'session:' + agent.session.sessionId,
      kind: 'finished',
      tone: status.tone === 'failed' ? 'danger' : agent.status === 'completed' ? 'success' : 'info',
      title: sessionAgentTitle(agent.session),
      detail: agent.detail,
      at: agent.endedAt,
    };
    recent.push({ ...eventRowView(event), session: agent.session, output: false });
  }
  return recent.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 12);
}

export function eventIcon(event: SessionChatWorkEvent): string {
  switch (event.kind) {
    case "finished":
      return event.tone === "danger"
        ? "x"
        : event.tone === "success"
          ? "check"
          : "stop";
    case "hook":
      return "plug";
    case "retry":
      return "refresh";
    case "compaction":
      return "shrink";
    case "transcript":
      return "file";
    case "plugin":
      return "download";
    default:
      return "bulb";
  }
}

export function eventRowView(event: SessionChatWorkEvent): EventRowView {
  const long =
    event.detail.length > OUTPUT_PREVIEW_CHARS ||
    event.detail.split("\n").length > OUTPUT_PREVIEW_LINES;
  return {
    event,
    icon: eventIcon(event),
    at: parseTime(event.at),
    output: event.kind === "hook" || long,
    long,
  };
}
