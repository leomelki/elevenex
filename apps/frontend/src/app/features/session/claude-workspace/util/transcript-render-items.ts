import type {
  ClaudeHookEvent,
  ClaudeSubagentState,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { PairedTranscriptUnit, pairTranscript } from './paired-transcript';
import { TurnAgentSummary, buildTurnAgentSummary } from './agent-deep-dive';
import { TurnChangeDetails, computeTurnChangeDetails } from './turn-change-stats';

export type TranscriptRenderItem =
  | { kind: 'unit'; id: string; unit: PairedTranscriptUnit }
  | {
      kind: 'collapsed-turn';
      id: string;
      turnId: string;
      hiddenUnits: PairedTranscriptUnit[];
      durationLabel: string;
      changeDetails: TurnChangeDetails | null;
      stepCount: number;
      agentSummary: TurnAgentSummary | null;
    };

export interface TranscriptRenderOptions {
  units: PairedTranscriptUnit[];
  /** Turns only collapse once nothing is streaming into them any more. */
  settled: boolean;
  childItemsByParentToolUseId: Record<string, ClaudeTranscriptItem[]>;
  subagents: ClaudeSubagentState[];
  hookEvents: ClaudeHookEvent[];
}

/**
 * Groups a paired transcript into what the UI actually renders: the user
 * prompt, a "Worked for X" pill standing in for the tool work of that turn, and
 * the final assistant reply.
 *
 * Shared by the session workspace and the embedded review/fork chats so both
 * read identically — a pure function rather than a base component because the
 * two surfaces wire up very different affordances around the same grouping.
 */
export function buildTranscriptRenderItems(
  options: TranscriptRenderOptions,
): TranscriptRenderItem[] {
  const { units, settled } = options;
  const out: TranscriptRenderItem[] = [];

  for (let i = 0; i < units.length; ) {
    const unit = units[i];
    if (!isUserMessageUnit(unit)) {
      out.push({ kind: 'unit', id: unit.id, unit });
      i += 1;
      continue;
    }

    const nextUserOffset = units.slice(i + 1).findIndex(isUserMessageUnit);
    const nextUserIndex = nextUserOffset === -1 ? units.length : i + 1 + nextUserOffset;

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
    // Split intermediate units two ways, preserving original chronological order
    // within each bucket:
    //   - sibling thinking shares the final assistant message's sourceMessageId, so
    //     it belongs right before that message as a content block of the same reply.
    //   - everything else (intermediate thinking, intermediate assistant text, tool
    //     calls, system messages) is the work that happened during the turn. When
    //     the turn settles it collapses into the "Worked for X" pill in natural
    //     order; expanding the pill replays the work as it actually happened.
    const lastAssistantSourceId = lastAssistantUnit.item.sourceMessageId;
    const intermediateUnits = turnUnits.slice(1, lastAssistantIndex);
    const siblingThinkingUnits: PairedTranscriptUnit[] = [];
    const collapsibleUnits: PairedTranscriptUnit[] = [];
    for (const intermediate of intermediateUnits) {
      if (
        intermediate.kind === 'thinking' &&
        lastAssistantSourceId &&
        intermediate.item.sourceMessageId === lastAssistantSourceId
      ) {
        siblingThinkingUnits.push(intermediate);
        continue;
      }
      collapsibleUnits.push(intermediate);
    }
    const tailUnits = turnUnits.slice(lastAssistantIndex + 1);
    const isCurrentTurn = nextUserIndex === units.length;
    const hasToolCalls = collapsibleUnits.some((u) => u.kind === 'tool');
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
        changeDetails: computeTurnChangeDetails(changeUnits),
        stepCount: collapsibleUnits.length,
        agentSummary: buildTurnAgentSummary(
          unit.id,
          getItemStartTimestamp(unit.item),
          getItemCompletionTimestamp(lastAssistantUnit.item),
          collapsibleUnits.length,
          options.subagents,
          options.hookEvents,
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
    out.push({ kind: 'unit', id: lastAssistantUnit.id, unit: lastAssistantUnit });
    for (const tailUnit of tailUnits) {
      out.push({ kind: 'unit', id: tailUnit.id, unit: tailUnit });
    }

    i = nextUserIndex;
  }

  return out;
}

/** Subagent work counts towards its parent turn's diff stats, so recurse into children. */
function collectTurnChangeUnits(
  units: PairedTranscriptUnit[],
  childItemsByParent: Record<string, ClaudeTranscriptItem[]>,
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
  return unit.kind === 'message' && unit.item.kind === 'user';
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

function getItemStartTimestamp(item: ClaudeTranscriptItem): string {
  return item.authoredAt || item.receivedAt || item.timestamp;
}

function getItemCompletionTimestamp(item: ClaudeTranscriptItem): string {
  return item.receivedAt || item.authoredAt || item.timestamp;
}
