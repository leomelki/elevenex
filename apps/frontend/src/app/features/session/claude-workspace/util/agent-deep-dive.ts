import {
  ClaudeHookEvent,
  ClaudeSubagentHistoryPayload,
  ClaudeSubagentState,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { PairedTranscriptUnit, pairTranscript } from './paired-transcript';

export interface TurnAgentRun {
  agentId: string;
  agentType: string;
  status: 'started' | 'stopped';
  transcriptPath?: string;
  summary?: string;
  stopHookActive?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastEventAt: string;
}

export interface TurnAgentSummary {
  turnId: string;
  startedAt: string;
  completedAt: string;
  durationLabel: string;
  stepCount: number;
  agents: TurnAgentRun[];
}

export interface AgentTimelineMessageEntry {
  kind: 'message';
  id: string;
  label: string;
  content: string;
  tone: 'neutral' | 'accent';
}

export interface AgentTimelineEventEntry {
  kind: 'event';
  id: string;
  label: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warning';
}

export interface AgentTimelineToolEntry {
  kind: 'tool';
  id: string;
  call: ClaudeTranscriptItem;
  result: ClaudeTranscriptItem | null;
}

export interface AgentTimelineClusterEntry {
  kind: 'cluster';
  id: string;
  label: string;
  items: ClaudeTranscriptItem[];
}

export type AgentTimelineEntry =
  | AgentTimelineMessageEntry
  | AgentTimelineEventEntry
  | AgentTimelineToolEntry
  | AgentTimelineClusterEntry;

export function buildTurnAgentSummary(
  turnId: string,
  startedAt: string,
  completedAt: string,
  stepCount: number,
  subagents: ClaudeSubagentState[],
  hookEvents: ClaudeHookEvent[],
): TurnAgentSummary | null {
  const agentById = new Map<string, TurnAgentRun>();
  const subagentById = new Map(subagents.map((item) => [item.agentId, item]));

  for (const event of hookEvents) {
    if (
      (event.eventName !== 'SubagentStart' && event.eventName !== 'SubagentStop')
      || !event.agentId
      || !event.agentType
      || !isTimestampInRange(event.timestamp, startedAt, completedAt)
    ) {
      continue;
    }

    const current = agentById.get(event.agentId);
    const subagent = subagentById.get(event.agentId);
    const lastEventAt = maxTimestamp(event.timestamp, current?.lastEventAt);
    agentById.set(event.agentId, {
      agentId: event.agentId,
      agentType: event.agentType,
      status: event.eventName === 'SubagentStop' ? 'stopped' : subagent?.status ?? 'started',
      transcriptPath: subagent?.transcriptPath,
      summary: subagent?.lastAssistantMessage,
      stopHookActive: subagent?.stopHookActive,
      startedAt:
        event.eventName === 'SubagentStart'
          ? minTimestamp(event.timestamp, current?.startedAt)
          : current?.startedAt,
      stoppedAt:
        event.eventName === 'SubagentStop'
          ? maxTimestamp(event.timestamp, current?.stoppedAt)
          : current?.stoppedAt,
      lastEventAt,
    });
  }

  for (const subagent of subagents) {
    if (!isTimestampInRange(subagent.timestamp, startedAt, completedAt)) continue;
    const current = agentById.get(subagent.agentId);
    agentById.set(subagent.agentId, {
      agentId: subagent.agentId,
      agentType: subagent.agentType,
      status: subagent.status,
      transcriptPath: subagent.transcriptPath,
      summary: subagent.lastAssistantMessage,
      stopHookActive: subagent.stopHookActive,
      startedAt: current?.startedAt,
      stoppedAt:
        subagent.status === 'stopped'
          ? maxTimestamp(subagent.timestamp, current?.stoppedAt)
          : current?.stoppedAt,
      lastEventAt: maxTimestamp(subagent.timestamp, current?.lastEventAt),
    });
  }

  const agents = [...agentById.values()].sort((left, right) =>
    (left.startedAt || left.lastEventAt).localeCompare(
      right.startedAt || right.lastEventAt,
    ),
  );

  if (!agents.length) return null;
  return {
    turnId,
    startedAt,
    completedAt,
    durationLabel: formatTurnDuration(startedAt, completedAt),
    stepCount,
    agents,
  };
}

export function buildAgentTimelineEntries(
  payload: ClaudeSubagentHistoryPayload | null,
  run: TurnAgentRun | null,
): AgentTimelineEntry[] {
  if (!payload || !run) return [];

  const entries: AgentTimelineEntry[] = [];
  const history = [...payload.history].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const units = pairTranscript(history);
  const prompt = history.find((item) => item.kind === 'user' && item.content?.trim());
  const assistantMessages = history.filter(
    (item) => item.kind === 'assistant' && item.content?.trim(),
  );
  const finalResponse =
    assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;

  entries.push({
    kind: 'event',
    id: `${run.agentId}:launch`,
    label: `Started ${humanizeAgentType(run.agentType)}`,
    detail: run.startedAt
      ? `Launched at ${formatTimestamp(run.startedAt)}`
      : `Observed at ${formatTimestamp(run.lastEventAt)}`,
    tone: 'neutral',
  });

  if (prompt?.content) {
    entries.push({
      kind: 'message',
      id: `${prompt.id}:prompt`,
      label: 'Prompt',
      content: prompt.content,
      tone: 'accent',
    });
  }

  let cluster: ClaudeTranscriptItem[] = [];
  for (const unit of units) {
    if (unit.kind === 'message') {
      if (
        unit.item.kind === 'assistant'
        && unit.item.id !== finalResponse?.id
        && unit.item.content?.trim()
      ) {
        flushCluster(entries, cluster);
        entries.push({
          kind: 'message',
          id: `${unit.item.id}:assistant`,
          label: 'Agent update',
          content: unit.item.content,
          tone: 'neutral',
        });
      }
      continue;
    }

    if (unit.kind === 'tool') {
      flushCluster(entries, cluster);
      entries.push({
        kind: 'tool',
        id: unit.id,
        call: unit.call,
        result: unit.result,
      });
      continue;
    }

    if (
      unit.kind === 'thinking'
      || (unit.kind === 'system' && (unit.item.content?.trim() || unit.item.toolName))
    ) {
      cluster.push(unit.item);
      continue;
    }
  }
  flushCluster(entries, cluster);

  if (finalResponse?.content) {
    entries.push({
      kind: 'message',
      id: `${finalResponse.id}:final`,
      label: 'Final response',
      content: finalResponse.content,
      tone: 'neutral',
    });
  }

  entries.push({
    kind: 'event',
    id: `${run.agentId}:finish`,
    label: run.status === 'stopped' ? 'Agent stopped' : 'Agent still active',
    detail:
      run.stoppedAt || run.lastEventAt
        ? formatTimestamp(run.stoppedAt || run.lastEventAt)
        : 'No completion timestamp',
    tone: run.status === 'stopped' ? 'success' : 'warning',
  });

  return entries;
}

export function buildAgentTranscriptUnits(
  payload: ClaudeSubagentHistoryPayload | null,
): PairedTranscriptUnit[] {
  if (!payload) return [];
  return pairTranscript(
    [...payload.history].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
  );
}

export function humanizeAgentType(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function flushCluster(
  entries: AgentTimelineEntry[],
  cluster: ClaudeTranscriptItem[],
): void {
  if (!cluster.length) return;
  entries.push({
    kind: 'cluster',
    id: `cluster:${cluster[0]?.id ?? entries.length}`,
    label: cluster.length === 1 ? 'Background note' : `${cluster.length} background notes`,
    items: [...cluster],
  });
  cluster.length = 0;
}

function isTimestampInRange(
  timestamp: string,
  startedAt: string,
  completedAt: string,
): boolean {
  const value = new Date(timestamp).getTime();
  return value >= new Date(startedAt).getTime()
    && value <= new Date(completedAt).getTime();
}

function maxTimestamp(left?: string, right?: string): string {
  if (!left) return right ?? '';
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function minTimestamp(left?: string, right?: string): string {
  if (!left) return right ?? '';
  if (!right) return left;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function formatTurnDuration(startedAt: string, completedAt: string): string {
  const ms = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${Math.max(1, totalSeconds)}s`;
  if (seconds === 0) return `${minutes}m`;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${minutes}m ${seconds}s`;
}
