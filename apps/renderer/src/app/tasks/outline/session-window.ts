import type { TaskSession, TaskSessionDisclosure } from '../task.models';

/** Supplied sessions stay chronological within the revealed and main lists.
 * Only still-hidden rows can be promoted by selection, attention or freshness. */
export function sessionWindow(
  sessions: readonly TaskSession[],
  cap: number,
  selected: string | null,
  filtered: boolean,
  disclosure: TaskSessionDisclosure | null = null,
) {
  const size = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 5;
  const boundary = size && !filtered ? Math.max(0, sessions.length - size) : 0;
  const expanded = disclosure !== null && disclosure.cap === cap;
  const hiddenIds = expanded ? new Set(disclosure.hiddenIds) : null;
  const pinned = (session: TaskSession) => session.id === selected || session.fresh || session.status === 'attention' || session.status === 'failed';
  const hidden = new Set(sessions.slice(0, boundary)
    .filter(session => (!hiddenIds || hiddenIds.has(session.id)) && !pinned(session))
    .map(session => session.id));
  // Older disclosures without batch metadata still restore their visible rows.
  const savedBatches = expanded ? disclosure.batches ?? [sessions.slice(0, boundary)
    .filter(session => !hiddenIds?.has(session.id) && !pinned(session)).map(session => session.id)] : [];
  const revealedIds = new Set(savedBatches.flat());
  const pool = sessions.filter(session => hidden.has(session.id) || revealedIds.has(session.id));
  const claimed = new Set<string>();
  // Take from the newest edge, carrying an archive gap across batch boundaries.
  // Existing revealed IDs remain eligible even when selected or needing you;
  // fresh arrivals stay in the main list. No refresh reapplies the initial cap.
  const batches = !boundary ? [] : savedBatches.map((ids, index) => {
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
