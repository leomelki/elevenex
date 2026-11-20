import { SESSION_CHAT_TURN_FILES_LIMIT, type SessionChatItem } from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { capturedChangeSummary, summarizeTurnChanges } from './desktop-chat-changes.js';
import { chatItem, chatItemChanges, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';
import type { ChatToolDetails, ProjectChatTool } from './desktop-chat-tool-details.js';
import { ChatToolLinks, type ChatToolPositions } from './desktop-chat-tool-links.js';
import { endOfChatTurn, type ChatCompletedTurns } from './desktop-chat-turns.js';

const SAVED_SUMMARY_LIMIT = 40;

/** Remember emitted page cursors and the last prompt span without retaining the provider's items. */
export class ChatHistoryIndex {
  private readonly positions = new Map<string, number>();
  private readonly tools: ChatToolPositions = new Map();
  private source = { size: 0, first: '', last: '' };
  private prompt?: { index: number; through: number; id?: string };

  align(history: readonly AgentTranscriptItem[]): void {
    const size = history.length, first = history[0]?.id ?? '', last = history.at(-1)?.id ?? '';
    if (size === this.source.size && first === this.source.first && last === this.source.last) return;
    this.source = { size, first, last };
    this.positions.clear();
    this.tools.clear();
    this.prompt = undefined;
  }

  fillTools(history: readonly AgentTranscriptItem[], links: ChatToolLinks): void {
    links.findMissing(history, this.tools);
  }

  position(history: readonly AgentTranscriptItem[], id: string, direction: 'before' | 'following' = 'before'): number {
    const known = this.positions.get(`${direction}:${id}`);
    if (known !== undefined && history[known]?.id === id) return known;
    // The forward edge of a saved span can end on a replayed block. On a
    // cold index, advance past every occurrence of that cursor.
    const matches = (item: AgentTranscriptItem) => item.id === id;
    const position = direction === 'following' ? history.findLastIndex(matches) : history.findIndex(matches);
    this.remember(id, position, direction);
    return position;
  }

  remember(id: string, position: number, direction: 'before' | 'following' = 'before'): void {
    if (position < 0) return;
    const key = `${direction}:${id}`;
    this.positions.delete(key);
    this.positions.set(key, position);
    if (this.positions.size > 256) this.positions.delete(this.positions.keys().next().value!);
  }

  promptBefore(history: readonly AgentTranscriptItem[], end: number): AgentTranscriptItem | undefined {
    return history[this.promptIndexBefore(history, end)];
  }

  promptIndexBefore(history: readonly AgentTranscriptItem[], end: number): number {
    const cached = this.prompt;
    const reusable = cached && end > cached.index &&
      (cached.index < 0 || history[cached.index]?.id === cached.id) ? cached : undefined;
    if (reusable && end <= reusable.through) return reusable.index;
    const found = previousPromptIndex(history, end, reusable?.through);
    const index = found >= 0 ? found : reusable?.index ?? -1;
    this.prompt = { index, through: end, id: history[index]?.id };
    return index;
  }
}

function previousPromptIndex(items: readonly AgentTranscriptItem[], end: number, start = 0): number {
  for (let index = end - 1; index >= start; index--)
    if (items[index].kind === 'user') return index;
  return -1;
}

interface ChatWindowOptions {
  readonly before?: string;
  readonly following?: string;
  readonly loadingMode?: 'window' | 'progressive';
  readonly changesCache?: ChatChangesCache;
  readonly mediaCache?: ChatMediaCache;
  readonly historyIndex?: ChatHistoryIndex;
  readonly fingerprints?: Map<string, string>;
  readonly includeLeadingPrompt?: boolean;
  readonly completedTurns?: ChatCompletedTurns;
  readonly summarizeRecent?: boolean;
  readonly toolDetails?: ChatToolDetails;
  readonly keepTurnId?: string;
  readonly liveTurn?: boolean;
}

interface Candidate {
  readonly item: AgentTranscriptItem;
  readonly historyIndex: number;
  readonly historyEnd: number;
  readonly liveIndex: number;
  readonly summary?: SessionChatItem;
}

/** A raw window can carry the same outcome as a compact turn once it has
 * the whole saved span. Partial windows and live rows use their available evidence. */
function savedWindowTurnChanges(
  ordered: readonly Candidate[], position: number, history: readonly AgentTranscriptItem[], live: boolean,
) {
  const prompt = ordered[position];
  if (prompt.historyIndex < 0 || prompt.liveIndex >= 0) return undefined;
  const rows = [prompt.item];
  let through = prompt.historyEnd;
  for (let index = position + 1; index < ordered.length; index++) {
    const candidate = ordered[index];
    if (candidate.item.kind === 'user') break;
    if (candidate.historyIndex < 0 || candidate.liveIndex >= 0) return undefined;
    through = Math.max(through, candidate.historyEnd);
    rows.push(candidate.item);
  }
  if (history[through + 1]?.kind !== 'user' && (through !== history.length - 1 || live)) return undefined;
  return summarizeTurnChanges(rows, SESSION_CHAT_TURN_FILES_LIMIT);
}

/** A saved turn can act as a single record only when both source boundaries
 * are inside this window. Otherwise the ordinary raw rows join the seam. */
function historyCandidates(
  history: readonly AgentTranscriptItem[], start: number, end: number, forward: boolean,
  limit: number, index: ChatHistoryIndex, live: readonly AgentTranscriptItem[], options: ChatWindowOptions,
  projectTool?: ProjectChatTool,
): readonly Candidate[] {
  const turns = options.completedTurns;
  const result: Candidate[] = [];
  const liveIds = new Set(turns ? live.map(item => item.id) : []);
  const step = forward ? 1 : -1;
  let position = forward ? start : end - 1;
  let summaryCount = 0;
  const lastPrompt = turns && options.liveTurn && end === history.length && !live.some(item => item.kind === 'user')
    ? index.promptIndexBefore(history, history.length) : -1;
  while (position >= start && position < end && result.length < limit && summaryCount < SAVED_SUMMARY_LIMIT) {
    const boundary = turns && (forward ? history[position].kind === 'user'
      : position + 1 === history.length || history[position + 1].kind === 'user');
    if (boundary) {
      const first = forward ? position : index.promptIndexBefore(history, position + 1);
      if (first >= start && first !== lastPrompt && history[first].id !== options.keepTurnId) {
        const through = forward ? endOfChatTurn(history, position) : position + 1;
        const summary = through <= end
          ? turns.summarize(history, first, through, liveIds, projectTool, options.summarizeRecent)
          : undefined;
        if (summary) {
          result.push({ item: history[first], summary, historyIndex: first, historyEnd: through - 1, liveIndex: -1 });
          summaryCount++;
          position = forward ? through : first - 1;
          continue;
        }
      }
    }
    result.push({ item: history[position], historyIndex: position, historyEnd: position, liveIndex: -1 });
    position += step;
  }
  return forward ? result : result.reverse();
}

/** Take bounded candidates before projecting. Keep source offsets so finding a
 * page's prompt never requires scanning back from the end of the transcript. */
export function chatWindow(
  history: readonly AgentTranscriptItem[],
  live: readonly AgentTranscriptItem[],
  options: ChatWindowOptions = {},
) {
  const { before, following, loadingMode, changesCache, mediaCache, fingerprints } = options;
  const historyIndex = options.historyIndex ?? new ChatHistoryIndex();
  historyIndex.align(history);
  const wideWindow = loadingMode === 'window' && !before && !following;
  // Adjacent pages overlap the renderer's retained 320-record window.
  const limit = wideWindow ? 320 : 80;
  const byteLimit = wideWindow ? 2 * 1024 * 1024 : 512 * 1024;
  const candidateLimit = limit * 2;
  const cursor = following ?? before;
  const historyPosition = cursor ? historyIndex.position(history, cursor, following ? 'following' : 'before') : history.length;
  const livePosition = cursor ? live.findIndex(item => item.id === cursor) : live.length;
  if (cursor && historyPosition < 0 && livePosition < 0) return null;

  const historyEnd = historyPosition < 0 ? history.length : historyPosition;
  const toolPage = options.toolDetails?.projectPage();
  const saved = historyCandidates(
    history, following ? (historyPosition < 0 ? history.length : historyPosition + 1) : 0,
    following ? history.length : historyEnd, !!following,
    options.completedTurns ? limit : candidateLimit, historyIndex, live, options, toolPage?.project,
  );
  const candidates = new Map<string, Candidate>();
  for (const candidate of saved) {
    const previous = candidates.get(candidate.item.id);
    candidates.set(candidate.item.id, previous && !candidate.summary && !previous.summary
      ? { ...candidate, historyIndex: previous.historyIndex } : candidate);
  }
  const addLive = (start: number, end: number, overlapOnly: boolean) => {
    for (let index = start; index < end; index++) {
      const item = live[index], saved = candidates.get(item.id);
      if (!overlapOnly || saved)
        candidates.set(item.id, { item, historyIndex: saved?.historyIndex ?? -1, historyEnd: saved?.historyEnd ?? -1, liveIndex: index });
    }
  };
  const moreHistory = !!following && historyPosition >= 0 && (saved.at(-1)?.historyEnd ?? historyPosition) + 1 < history.length;
  let moreLive = false;
  if (following) {
    const start = Math.max(0, livePosition + 1);
    const end = Math.min(start + candidateLimit, live.length);
    addLive(start, end, moreHistory);
    moreLive = end < live.length;
  } else {
    if (livePosition >= 0) addLive(Math.max(0, livePosition - candidateLimit), livePosition, false);
    else addLive(0, live.length, true);
  }

  const ordered = [...candidates.values()];
  const links = new ChatToolLinks(ordered.map(({ item }) => item));
  if (toolPage) {
    links.findMissing(live);
    historyIndex.fillTools(history, links);
  }
  const items: SessionChatItem[] = [];
  let bytes = 0;
  let edge = following ? 0 : ordered.length;
  while ((following ? edge < ordered.length : edge > 0) && items.length < limit) {
    const position = following ? edge : edge - 1;
    const { item: raw, summary } = ordered[position];
    const peer = links.peer(raw);
    const call = raw.kind === 'tool_result' ? peer : undefined;
    let item: SessionChatItem = summary ?? toolPage?.activity(raw, peer) ?? chatItem(raw, call, changesCache, mediaCache);
    if (!summary && raw.kind === 'user') {
      const turnChanges = savedWindowTurnChanges(ordered, position, history, !!options.liveTurn);
      if (turnChanges) item = { ...item, turnChanges };
    }
    if (!summary && raw.turnChanges) {
      let turnStart = position - 1;
      while (turnStart >= 0 && ordered[turnStart].item.kind !== 'user') turnStart--;
      const changes = [];
      for (let index = Math.max(0, turnStart); index < position; index++) {
        const { item: result } = ordered[index];
        if (result.kind !== 'tool_result') continue;
        const call = links.peer(result);
        if (call) changes.push(chatItemChanges(result, call, changesCache));
      }
      item = { ...item, changes: capturedChangeSummary(raw, changes) };
    }
    const fingerprint = JSON.stringify(item);
    bytes += Buffer.byteLength(fingerprint);
    if (bytes > byteLimit) break;
    fingerprints?.set(item.id, fingerprint);
    if (summary) historyIndex.remember(item.id, ordered[position].historyIndex);
    items.push(item);
    edge += following ? 1 : -1;
  }
  if (!following) items.reverse();
  const first = ordered[following ? 0 : edge];
  const last = ordered[following ? edge - 1 : ordered.length - 1];
  let prompt: AgentTranscriptItem | undefined;
  if (items.length) {
    toolPage?.commit();
    historyIndex.remember(first.item.id, first.historyIndex);
    historyIndex.remember(last.summary?.completedTurn?.endId ?? last.item.id, last.historyEnd, 'following');
    // Saved rows keep their saved order, including live overlays of their IDs.
    // For a live-only tail, look within live activity before falling back to
    // the last saved prompt. Neither context record becomes a page cursor.
    if (options.includeLeadingPrompt !== false && first.item.kind !== 'user')
      prompt = first.historyIndex >= 0 ? historyIndex.promptBefore(history, first.historyIndex)
        : live[previousPromptIndex(live, first.liveIndex)] ?? historyIndex.promptBefore(history, historyEnd);
  }
  return {
    items,
    leadingPrompt: prompt ? chatItem(prompt, undefined, changesCache, mediaCache) : null,
    before:
      following || edge > 0 || (saved[0]?.historyIndex ?? historyEnd) > 0 || livePosition > candidateLimit
        ? items[0]?.id ?? null : null,
    next: before || (following && (edge < ordered.length || moreHistory || moreLive))
      ? last?.summary?.completedTurn?.endId ?? items.at(-1)?.id ?? null : null,
  };
}
