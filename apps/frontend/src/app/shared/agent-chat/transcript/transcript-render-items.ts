import {
  TurnAgentSummary,
  buildTurnAgentSummary,
} from '@/shared/agent-chat/activity/agent-deep-dive';
import { isToolDenied, toolDenialBatch } from '@/shared/agent-chat/tools/tool-denial';
import {
  TurnChangeDetails,
  computeTurnChangeDetails,
} from '@/shared/agent-chat/tools/turn-change-stats';
import {
  PairedTranscriptUnit,
  pairTranscript,
} from '@/shared/agent-chat/transcript/paired-transcript';
import type {
  AgentHookEvent,
  AgentSubagentState,
  AgentTranscriptItem,
} from '@/shared/models/agent-runtime.model';
import { isUserPrompt } from '@/shared/utils/user-message-display';
import { buildElevenexToolView, elevenexToolName } from '@/shared/agent-tools/elevenex-tool-view';
import { PORT_FORWARDING_TOOL_NAMES } from '@/shared/agent-tools/port-forwarding-receipt';

export type TranscriptRenderItem =
  | { kind: 'unit'; id: string; unit: PairedTranscriptUnit }
  | { kind: 'tool-denial'; id: string; call: AgentTranscriptItem }
  | {
      kind: 'collapsed-turn';
      id: string;
      turnId: string;
      hiddenUnits: PairedTranscriptUnit[];
      durationLabel: string;
      changeDetails: TurnChangeDetails | null;
      stepCount: number;
      agentSummary: TurnAgentSummary | null;
      portForwardingAttention?: number;
    };

export interface TranscriptRenderOptions {
  units: PairedTranscriptUnit[];
  /** Turns only collapse once nothing is streaming into them any more. */
  settled: boolean;
  childItemsByParentToolUseId: Record<string, AgentTranscriptItem[]>;
  subagents: AgentSubagentState[];
  hookEvents: AgentHookEvent[];
}

/** Settled tool inputs/results retain their identity while the active reply streams. */
export class TurnChangeCache {
  private readonly entries = new Map<
    string,
    { tools: Extract<PairedTranscriptUnit, { kind: 'tool' }>[]; details: TurnChangeDetails | null }
  >();

  compute(turnId: string, units: PairedTranscriptUnit[]): TurnChangeDetails | null {
    const tools = units.filter(
      (unit): unit is Extract<PairedTranscriptUnit, { kind: 'tool' }> => unit.kind === 'tool',
    );
    const previous = this.entries.get(turnId);
    if (
      previous &&
      previous.tools.length === tools.length &&
      tools.every(
        (tool, index) =>
          tool.call === previous.tools[index].call && tool.result === previous.tools[index].result,
      )
    ) {
      return previous.details;
    }
    const details = computeTurnChangeDetails(tools);
    this.entries.set(turnId, { tools, details });
    return details;
  }

  retain(turnIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!turnIds.has(id)) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Groups a paired transcript into what the UI actually renders: the user
 * prompt, a "Worked for X" pill standing in for the tool work of that turn, and
 * the final assistant replies.
 *
 * Shared by the session workspace and the embedded review/fork chats so both
 * read identically — a pure function rather than a base component because the
 * two surfaces wire up very different affordances around the same grouping.
 */
export function buildTranscriptRenderItems(
  options: TranscriptRenderOptions,
  changeCache?: TurnChangeCache,
): TranscriptRenderItem[] {
  const { units, settled } = options;
  const out: Exclude<TranscriptRenderItem, { kind: 'tool-denial' }>[] = [];

  for (let i = 0; i < units.length; ) {
    const unit = units[i];
    if (!isUserMessageUnit(unit)) {
      out.push({ kind: 'unit', id: unit.id, unit });
      i += 1;
      continue;
    }

    let nextUserIndex = i + 1;
    while (nextUserIndex < units.length && !isUserMessageUnit(units[nextUserIndex])) {
      nextUserIndex += 1;
    }

    const turnUnits = units.slice(i, nextUserIndex);
    const lastAssistantIndex = findLastAssistantIndex(turnUnits);
    if (lastAssistantIndex === -1) {
      for (const turnUnit of turnUnits) {
        out.push({ kind: 'unit', id: turnUnit.id, unit: turnUnit });
      }
      i = nextUserIndex;
      continue;
    }

    const lastAssistantUnit = turnUnits[lastAssistantIndex] as Extract<
      PairedTranscriptUnit,
      { kind: 'message' }
    >;
    const firstFinalAssistantIndex = findFinalAssistantStartIndex(turnUnits, lastAssistantIndex);
    const firstFinalAssistantUnit = turnUnits[firstFinalAssistantIndex] as Extract<
      PairedTranscriptUnit,
      { kind: 'message' }
    >;
    // Split intermediate units two ways, preserving original chronological order
    // within each bucket:
    //   - sibling thinking shares the first final reply's sourceMessageId, so
    //     it belongs right before that message as a content block of the same reply.
    //   - everything else (intermediate thinking, intermediate assistant text, tool
    //     calls, system messages) is the work that happened during the turn. When
    //     the turn settles it collapses into the "Worked for X" pill in natural
    //     order; expanding the pill replays the work as it actually happened.
    const firstFinalAssistantSourceId = firstFinalAssistantUnit.item.sourceMessageId;
    const intermediateUnits = turnUnits.slice(1, firstFinalAssistantIndex);
    const siblingThinkingUnits: PairedTranscriptUnit[] = [];
    const collapsibleUnits: PairedTranscriptUnit[] = [];
    let stepCount = 0;
    let hasToolCalls = false;
    for (const intermediate of intermediateUnits) {
      if (
        intermediate.kind === 'thinking' &&
        firstFinalAssistantSourceId &&
        intermediate.item.sourceMessageId === firstFinalAssistantSourceId
      ) {
        siblingThinkingUnits.push(intermediate);
        continue;
      }
      collapsibleUnits.push(intermediate);
      // Human prompts delimit turns; user items inside a turn are injected
      // context or synthetic events, rather than work steps.
      if (intermediate.kind !== 'message' || intermediate.item.kind !== 'user') stepCount += 1;
      if (intermediate.kind === 'tool') hasToolCalls = true;
    }
    const finalUnits = turnUnits.slice(firstFinalAssistantIndex);
    const isCurrentTurn = nextUserIndex === units.length;
    const canCollapse = hasToolCalls && (!isCurrentTurn || settled);

    out.push({ kind: 'unit', id: unit.id, unit });

    if (canCollapse) {
      const changeUnits = collectTurnChangeUnits(
        collapsibleUnits,
        options.childItemsByParentToolUseId,
      );
      out.push({
        kind: 'collapsed-turn',
        id: `collapsed-${unit.id}`,
        turnId: unit.id,
        hiddenUnits: collapsibleUnits,
        durationLabel: formatTurnDuration(
          getItemStartTimestamp(unit.item),
          getItemCompletionTimestamp(lastAssistantUnit.item),
        ),
        changeDetails: changeCache
          ? changeCache.compute(unit.id, changeUnits)
          : computeTurnChangeDetails(changeUnits),
        stepCount,
        portForwardingAttention: collapsibleUnits.filter((entry) => {
          if (
            entry.kind !== 'tool' ||
            !entry.result ||
            !PORT_FORWARDING_TOOL_NAMES.has(elevenexToolName(entry.call) ?? '')
          )
            return false;
          const view = buildElevenexToolView(entry.call, entry.result);
          return !!view?.error || view?.portForwarding?.needsAttention === true;
        }).length,
        agentSummary: buildTurnAgentSummary(
          unit.id,
          getItemStartTimestamp(unit.item),
          getItemCompletionTimestamp(lastAssistantUnit.item),
          stepCount,
          options.subagents,
          options.hookEvents,
          new Set(
            collapsibleUnits.flatMap((entry) => (entry.kind === 'tool' ? [entry.toolUseId] : [])),
          ),
          new Set(
            collapsibleUnits.flatMap((entry) => {
              if (entry.kind !== 'tool') return [];
              const input = entry.call.providerToolInput ?? entry.call.toolInput;
              if (!input || typeof input !== 'object') return [];
              const data = input as Record<string, unknown>;
              return [
                data['id'],
                data['target'],
                data['agent_id'],
                ...(Array.isArray(data['ids']) ? data['ids'] : []),
                ...(Array.isArray(data['receiverThreadIds']) ? data['receiverThreadIds'] : []),
              ].filter((value): value is string => typeof value === 'string');
            }),
          ),
        ),
      });
    } else {
      for (const hiddenUnit of collapsibleUnits) {
        out.push({ kind: 'unit', id: hiddenUnit.id, unit: hiddenUnit });
      }
    }

    for (const siblingThinkingUnit of siblingThinkingUnits) {
      out.push({ kind: 'unit', id: siblingThinkingUnit.id, unit: siblingThinkingUnit });
    }
    for (const finalUnit of finalUnits) {
      out.push({ kind: 'unit', id: finalUnit.id, unit: finalUnit });
    }

    i = nextUserIndex;
  }

  changeCache?.retain(
    new Set(
      out
        .filter((item) => item.kind === 'collapsed-turn')
        .map((item) => item.id.replace(/^collapsed-/, '')),
    ),
  );

  // Human feedback stays in the conversation even when the agent's work is
  // collapsed. Generate it once here so expanding a turn cannot duplicate it.
  const seenDenials = new Set<string>();
  const collectDenials = (entries: PairedTranscriptUnit[]): TranscriptRenderItem[] => {
    const denials: TranscriptRenderItem[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'tool') continue;
      if (isToolDenied(entry.call)) {
        // Parallel calls sharing one permission request are one human decision.
        const key = toolDenialBatch(entry.call)[0]?.toolUseId ?? entry.toolUseId;
        if (!seenDenials.has(key)) {
          seenDenials.add(key);
          denials.push({ kind: 'tool-denial', id: `denial-${key}`, call: entry.call });
        }
      }
      const children = options.childItemsByParentToolUseId[entry.toolUseId];
      if (children?.length) denials.push(...collectDenials(pairTranscript(children)));
    }
    return denials;
  };
  return out.flatMap((item): TranscriptRenderItem[] => {
    const entries = item.kind === 'collapsed-turn' ? item.hiddenUnits : [item.unit];
    return [item, ...collectDenials(entries)];
  });
}

/** Subagent work counts towards its parent turn's diff stats, so recurse into children. */
function collectTurnChangeUnits(
  units: PairedTranscriptUnit[],
  childItemsByParent: Record<string, AgentTranscriptItem[]>,
): PairedTranscriptUnit[] {
  const collected: PairedTranscriptUnit[] = [];
  const visit = (entries: PairedTranscriptUnit[]) => {
    for (const entry of entries) {
      collected.push(entry);
      if (entry.kind !== 'tool') continue;
      const children = childItemsByParent[entry.toolUseId] ?? [];
      if (children.length) {
        visit(pairTranscript(children));
      }
    }
  };
  visit(units);
  return collected;
}

function isUserMessageUnit(
  unit: PairedTranscriptUnit,
): unit is Extract<PairedTranscriptUnit, { kind: 'message' }> {
  return unit.kind === 'message' && isUserPrompt(unit.item);
}

function isAssistantMessageUnit(
  unit: PairedTranscriptUnit,
): unit is Extract<PairedTranscriptUnit, { kind: 'message' }> {
  return unit.kind === 'message' && unit.item.kind === 'assistant';
}

function findLastAssistantIndex(units: PairedTranscriptUnit[]): number {
  for (let i = units.length - 1; i >= 0; i--) {
    if (isAssistantMessageUnit(units[i])) return i;
  }
  return -1;
}

/** All assistant messages after the last tool call belong to the final output. */
function findFinalAssistantStartIndex(
  units: PairedTranscriptUnit[],
  lastAssistantIndex: number,
): number {
  let firstIndex = lastAssistantIndex;
  for (let i = lastAssistantIndex - 1; i > 0; i--) {
    if (units[i].kind === 'tool') break;
    if (isAssistantMessageUnit(units[i])) firstIndex = i;
  }
  return firstIndex;
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

function getItemStartTimestamp(item: AgentTranscriptItem): string {
  return item.authoredAt || item.receivedAt || item.timestamp;
}

function getItemCompletionTimestamp(item: AgentTranscriptItem): string {
  return item.receivedAt || item.authoredAt || item.timestamp;
}
