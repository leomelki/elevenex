import { createHash } from 'node:crypto';
import {
  renderMarkdown,
  type ConversationExportModel,
  type ConversationExportOptions,
} from '../../../agent-runtime/conversation-export.service.js';

interface TranscriptCursor {
  version: 1;
  identity: string;
  turns: number;
  itemCount: number;
  boundary: string;
  pending?: {
    end: number;
    offset: number;
    fingerprint: string;
    includePreamble: boolean;
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Page rendered content without advancing past text that has not been delivered. */
export function transcriptWindow(
  model: ConversationExportModel,
  itemCount: number,
  identity: string,
  rawCursor: string | undefined,
  options: ConversationExportOptions & {
    refresh?: boolean;
    maxTurns?: number;
    maxCharacters?: number;
  },
) {
  const totalTurns = model.turns.length;
  const identityKey = fingerprint(identity);
  let previous: TranscriptCursor | undefined;
  try {
    const parsed = JSON.parse(rawCursor ?? 'null') as TranscriptCursor | null;
    if (
      parsed?.version === 1 &&
      Number.isInteger(parsed.turns) &&
      parsed.turns >= 0 &&
      Number.isInteger(parsed.itemCount) &&
      parsed.itemCount >= 0 &&
      typeof parsed.boundary === 'string' &&
      (!parsed.pending ||
        (Number.isInteger(parsed.pending.end) &&
          parsed.pending.end >= parsed.turns &&
          Number.isInteger(parsed.pending.offset) &&
          parsed.pending.offset >= 0 &&
          typeof parsed.pending.fingerprint === 'string'))
    )
      previous = parsed;
  } catch {
    /* Old or malformed cursors trigger a fresh read. */
  }
  const boundaryAt = (turns: number) =>
    fingerprint(turns ? model.turns[turns - 1] : model.preamble);
  const reset =
    options.refresh === true ||
    (previous !== undefined &&
      (previous.identity !== identityKey ||
        previous.turns > totalTurns ||
        previous.itemCount > itemCount ||
        (previous.pending !== undefined && previous.pending.end > totalTurns)));
  if (reset) previous = undefined;
  let delta = previous !== undefined;
  let fromTurn = previous?.turns ?? 0;
  // A growing/replaced final turn can retain both its item count and ID. Compare
  // its content too, so streamed completion and edited history are re-delivered.
  if (previous && previous.boundary !== boundaryAt(fromTurn)) {
    if (fromTurn === 0) {
      previous = undefined;
      delta = false;
    } else {
      fromTurn--;
      previous = { ...previous, pending: undefined };
    }
  }
  const lastTurnUpdated = delta && fromTurn < (previous?.turns ?? 0);
  if (previous && fromTurn === totalTurns && !previous.pending) {
    return {
      data: { delta, newTurns: 0, totalTurns },
      cursor: rawCursor!,
      truncated: false,
    };
  }
  const maxTurns = Math.min(50, Math.max(1, options.maxTurns ?? 20));
  const maxCharacters = Math.min(
    24000,
    Math.max(1000, options.maxCharacters ?? 12000),
  );
  const end = Math.min(
    totalTurns,
    previous?.pending?.end ?? fromTurn + maxTurns,
  );
  const includePreamble =
    fromTurn === 0 && (!delta || previous?.pending?.includePreamble === true);
  const markdown = renderMarkdown(
    {
      ...model,
      // Stable metadata makes character continuation independent of export time.
      meta: { ...model.meta, exportedAt: '' },
      preamble: includePreamble ? model.preamble : [],
      turns: model.turns.slice(fromTurn, end),
    },
    { ...options, turnNumberOffset: fromTurn },
  );
  const digest = fingerprint(markdown);
  const pending = previous?.pending;
  const offset =
    pending?.fingerprint === digest && pending.offset < markdown.length
      ? pending.offset
      : 0;
  let next = Math.min(markdown.length, offset + maxCharacters);
  // Keep a surrogate pair together when the character budget lands inside it.
  if (next < markdown.length && /[\uD800-\uDBFF]/.test(markdown[next - 1]))
    next--;
  const partial = next < markdown.length;
  const consumed = partial ? fromTurn : end;
  const cursor: TranscriptCursor = {
    version: 1,
    identity: identityKey,
    turns: consumed,
    itemCount,
    boundary: boundaryAt(consumed),
    ...(partial
      ? { pending: { end, offset: next, fingerprint: digest, includePreamble } }
      : {}),
  };
  return {
    data: {
      delta,
      newTurns: Math.max(0, end - (previous?.turns ?? 0)),
      totalTurns,
      returnedTurns: end - fromTurn,
      firstTurn: fromTurn + 1,
      lastTurnUpdated,
      continued: offset > 0,
      nextOffset: partial ? next : null,
      remainingTurns: totalTurns - end,
      cursorReset: reset,
      markdown: markdown.slice(offset, next),
    },
    cursor: JSON.stringify(cursor),
    truncated: partial || end < totalTurns,
  };
}
