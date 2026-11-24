import { isWorkspacePriorityStatus } from '@elevenex/shared';
import type { TaskSession, TaskSessionDisclosure } from '../task.models';

/** Supplied sessions stay chronological within the revealed and main lists.
 * Only still-hidden rows can be promoted by selection, activity or freshness. */
export function sessionWindow(
  sessions: readonly TaskSession[],
  cap: number,
  selected: string | null,
  filtered: boolean,
  disclosure: TaskSessionDisclosure | null = null,
  priorityParents: ReadonlySet<string> = new Set(),
) {
  const size = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 5;
  const expanded = disclosure !== null && disclosure.cap === cap;
  if (!size || filtered || sessions.length <= size)
    return { hidden: new Set<string>(), batches: [], shown: sessions, muted: null, expanded };
  const hiddenIds = expanded ? new Set(disclosure.hiddenIds) : null;
  const pinned = (session: TaskSession) => session.id === selected || session.fresh ||
    isWorkspacePriorityStatus(session.status) || priorityParents.has(session.id);
  const pinnedCount = sessions.filter(pinned).length;
  let available = Math.max(0, size - pinnedCount);
  const older = new Set<string>();
  for (const session of [...sessions].reverse()) {
    if (pinned(session)) continue;
    if (available > 0) available--;
    else older.add(session.id);
  }
  // Keep the Set in supplied order so Older opens from the newest hidden edge.
  const hidden = new Set(sessions.filter(session => older.has(session.id) &&
    (!hiddenIds || hiddenIds.has(session.id))).map(session => session.id));
  // Older disclosures without batch metadata still restore their visible rows.
  const savedBatches = expanded ? disclosure.batches ?? [sessions
    .filter(session => older.has(session.id) && !hiddenIds?.has(session.id)).map(session => session.id)] : [];
  const revealedIds = new Set(savedBatches.flat());
  const pool = sessions.filter(session => hidden.has(session.id) || revealedIds.has(session.id));
  const claimed = new Set<string>();
  // Take from the newest edge, carrying an archive gap across batch boundaries.
  // Existing revealed IDs remain eligible even when selected or needing you;
  // fresh arrivals stay in the main list. No refresh reapplies the initial cap.
  const batches = savedBatches.map((ids, index) => {
    const rows = pool.splice(Math.max(0, pool.length - ids.length));
    for (const session of rows) {
      hidden.delete(session.id);
      claimed.add(session.id);
    }
    return { key: `batch:${index}`, sessions: rows };
  }).filter(batch => batch.sessions.length);
  const shown = sessions.filter(session => !hidden.has(session.id) && !claimed.has(session.id));
  const first = batches.at(-1)?.sessions[0] ?? shown[0];
  const muted = hidden.size && first && !pinned(first) ? first.id : null;
  return { hidden, batches, shown, muted, expanded };
}

/** Split a reveal where an already-visible row interrupts it. This lets each
 * new run animate in place while existing rows keep their identity and order. */
export function sessionBatchSegments(
  roots: readonly TaskSession[],
  window: ReturnType<typeof sessionWindow>,
) {
  const batchKeys = new Map(window.batches.flatMap(batch =>
    batch.sessions.map(session => [session.id, batch.key] as const)));
  const counters = new Map<string, number>();
  const segments: { key: string; position: number; sessions: TaskSession[] }[] = [];
  const shown = new Set(window.shown.map(row => row.id));
  let lastBatch: string | undefined;
  roots.forEach((session, position) => {
    const batch = batchKeys.get(session.id);
    if (!batch) {
      if (shown.has(session.id)) lastBatch = undefined;
      return;
    }
    if (batch !== lastBatch) {
      const segment = counters.get(batch) ?? 0;
      counters.set(batch, segment + 1);
      segments.push({ key: segment ? `${batch}:${segment}` : batch, position, sessions: [] });
      lastBatch = batch;
    }
    segments.at(-1)?.sessions.push(session);
  });
  return segments;
}
