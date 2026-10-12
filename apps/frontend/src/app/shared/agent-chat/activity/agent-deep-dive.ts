import {
  PairedTranscriptUnit,
  pairTranscript,
} from '@/shared/agent-chat/transcript/paired-transcript';
import {
  AgentHookEvent,
  AgentSubagentHistoryPayload,
  AgentSubagentState,
  AgentTranscriptItem,
} from '@/shared/models/agent-runtime.model';

export interface TurnAgentRun extends Omit<
  AgentSubagentState,
  'timestamp' | 'lastAssistantMessage'
> {
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
  scope?: 'session' | 'turn';
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
  tone: 'neutral' | 'success' | 'warning' | 'destructive';
}

export interface AgentTimelineToolEntry {
  kind: 'tool';
  id: string;
  call: AgentTranscriptItem;
  result: AgentTranscriptItem | null;
}

export interface AgentTimelineClusterEntry {
  kind: 'cluster';
  id: string;
  label: string;
  items: AgentTranscriptItem[];
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
  subagents: AgentSubagentState[],
  hookEvents: AgentHookEvent[],
  toolIds: ReadonlySet<string> = new Set(),
  referencedAgentIds: ReadonlySet<string> = new Set(),
): TurnAgentSummary | null {
  const agentById = new Map<string, TurnAgentRun>();
  const subagentById = new Map(subagents.map((item) => [item.agentId, item]));

  for (const event of hookEvents) {
    if (
      (event.eventName !== 'SubagentStart' && event.eventName !== 'SubagentStop') ||
      !event.agentId ||
      !event.agentType ||
      !isTimestampInRange(event.timestamp, startedAt, completedAt)
    ) {
      continue;
    }

    const current = agentById.get(event.agentId);
    const subagent = subagentById.get(event.agentId);
    const lastEventAt = maxTimestamp(event.timestamp, current?.lastEventAt);
    agentById.set(event.agentId, {
      agentId: event.agentId,
      agentType: event.agentType,
      status: event.eventName === 'SubagentStop' ? 'stopped' : (subagent?.status ?? 'started'),
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

  const included = new Set(
    subagents
      .filter(
        (agent) =>
          isTimestampInRange(agent.startedAt ?? agent.timestamp, startedAt, completedAt) ||
          (agent.parentToolUseId && toolIds.has(agent.parentToolUseId)) ||
          referencedAgentIds.has(agent.agentId) ||
          (agent.agentPath && referencedAgentIds.has(agent.agentPath)),
      )
      .map((agent) => agent.agentId),
  );
  // Include nested delegations with their ancestor, even if they finish after this turn.
  for (let previous = -1; previous !== included.size; ) {
    previous = included.size;
    for (const agent of subagents)
      if (agent.parentAgentId && included.has(agent.parentAgentId)) included.add(agent.agentId);
  }
  for (const subagent of subagents) {
    if (!included.has(subagent.agentId)) continue;
    const current = agentById.get(subagent.agentId);
    agentById.set(subagent.agentId, {
      ...subagent,
      agentId: subagent.agentId,
      agentType: subagent.agentType,
      status: subagent.status,
      transcriptPath: subagent.transcriptPath,
      summary: subagent.lastAssistantMessage,
      stopHookActive: subagent.stopHookActive,
      startedAt: subagent.startedAt ?? current?.startedAt,
      stoppedAt:
        subagent.status === 'stopped'
          ? (subagent.completedAt ?? maxTimestamp(subagent.timestamp, current?.stoppedAt))
          : current?.stoppedAt,
      lastEventAt: maxTimestamp(subagent.timestamp, current?.lastEventAt),
    });
  }

  const agents = [...agentById.values()].sort((left, right) =>
    (left.startedAt || left.lastEventAt).localeCompare(right.startedAt || right.lastEventAt),
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

export function buildSessionAgentSummary(subagents: AgentSubagentState[]): TurnAgentSummary | null {
  if (!subagents.length) return null;
  const start = subagents.map((agent) => agent.startedAt ?? agent.timestamp).sort()[0];
  const end = subagents
    .map((agent) => agent.timestamp)
    .sort()
    .at(-1)!;
  return {
    turnId: 'session-agents',
    scope: 'session',
    startedAt: start,
    completedAt: end,
    durationLabel: formatTurnDuration(start, end),
    stepCount: 0,
    agents: subagents.map((agent) => ({
      ...agent,
      summary: agent.lastAssistantMessage,
      stoppedAt: agent.completedAt,
      lastEventAt: agent.timestamp,
    })),
  };
}

export function buildAgentTimelineEntries(
  payload: AgentSubagentHistoryPayload | null,
  run: TurnAgentRun | null,
): AgentTimelineEntry[] {
  if (!run) return [];

  const entries: AgentTimelineEntry[] = [];
  const history = [...(payload?.history ?? [])].sort((left, right) =>
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

  if (prompt?.content || run.prompt) {
    entries.push({
      kind: 'message',
      id: `${prompt?.id ?? run.agentId}:prompt`,
      label: 'Prompt',
      content: prompt?.content ?? run.prompt!,
      tone: 'accent',
    });
  }

  let cluster: AgentTranscriptItem[] = [];
  for (const unit of units) {
    if (unit.kind === 'message') {
      if (
        unit.item.kind === 'assistant' &&
        unit.item.id !== finalResponse?.id &&
        unit.item.content?.trim()
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
      unit.kind === 'thinking' ||
      (unit.kind === 'system' && (unit.item.content?.trim() || unit.item.toolName))
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
      label: run.status === 'stopped' ? 'Final response' : 'Latest update',
      content: finalResponse.content,
      tone: 'neutral',
    });
  }

  entries.push({
    kind: 'event',
    id: `${run.agentId}:finish`,
    label:
      run.executionStatus === 'error'
        ? 'Agent failed'
        : run.executionStatus === 'interrupted'
          ? 'Agent interrupted'
          : run.executionStatus === 'closed'
            ? 'Agent closed'
            : run.status === 'stopped'
              ? 'Agent completed'
              : 'Agent still active',
    detail:
      run.stoppedAt || run.lastEventAt
        ? formatTimestamp(run.stoppedAt || run.lastEventAt)
        : 'No completion timestamp',
    tone:
      run.executionStatus === 'error'
        ? 'destructive'
        : run.executionStatus === 'interrupted'
          ? 'warning'
          : run.status === 'stopped'
            ? 'success'
            : 'neutral',
  });

  return entries;
}

export function buildAgentTranscriptUnits(
  payload: AgentSubagentHistoryPayload | null,
): PairedTranscriptUnit[] {
  if (!payload) return [];
  return pairTranscript(
    [...payload.history].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
  );
}

export function humanizeAgentType(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function flushCluster(entries: AgentTimelineEntry[], cluster: AgentTranscriptItem[]): void {
  if (!cluster.length) return;
  entries.push({
    kind: 'cluster',
    id: `cluster:${cluster[0]?.id ?? entries.length}`,
    label: cluster.length === 1 ? 'Background note' : `${cluster.length} background notes`,
    items: [...cluster],
  });
  cluster.length = 0;
}

function isTimestampInRange(timestamp: string, startedAt: string, completedAt: string): boolean {
  const value = new Date(timestamp).getTime();
  return value >= new Date(startedAt).getTime() && value <= new Date(completedAt).getTime();
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
