import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

/** Both paging directions must walk the same sequence. Live rows keep their
 * first observed position even when the harness's saved receipts complete out
 * of order. Shared anchors delimit gaps, whose unshared rows are interleaved
 * by their reported time without sorting either source. */
export function mergeTranscriptRows(
  history: readonly AgentTranscriptItem[], live: readonly AgentTranscriptItem[],
) {
  const liveItems = new Map(live.map(item => [item.id, item]));
  if (!liveItems.size) return { rows: history, liveItems, savedItems: new Map<string, AgentTranscriptItem>() };
  const current = [...liveItems.values()];
  const first = history.findIndex(item => liveItems.has(item.id));
  const savedItems = new Map<string, AgentTranscriptItem>();
  if (first < 0) return { rows: history.concat(current), liveItems, savedItems };

  const positions = new Map(current.map((item, index) => [item.id, index]));
  const rows = history.slice(0, first);
  let next = 0;
  let savedOnly: AgentTranscriptItem[] = [];
  const appendGap = (through: number) => {
    let saved = 0;
    while (next < through && saved < savedOnly.length) {
      const liveTime = Date.parse(current[next].timestamp);
      const savedTime = Date.parse(savedOnly[saved].timestamp);
      rows.push(liveTime <= savedTime ? current[next++] : savedOnly[saved++]);
    }
    while (next < through) rows.push(current[next++]);
    while (saved < savedOnly.length) rows.push(savedOnly[saved++]);
    savedOnly = [];
  };
  for (let index = first; index < history.length; index++) {
    const item = history[index];
    const position = positions.get(item.id);
    if (position === undefined) {
      savedOnly.push(item);
      continue;
    }
    savedItems.set(item.id, item);
    if (position < next) continue;
    appendGap(position);
    rows.push(current[next++]);
  }
  appendGap(current.length);
  return { rows, liveItems, savedItems };
}
