import { SESSION_CHAT_TURN_FILES_LIMIT, type SessionChatItem } from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { capturedChangeSummary, summarizeTurnChanges } from './desktop-chat-changes.js';
import { chatItem, chatItemChanges, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';
import type { ChatToolDetails, ProjectChatTool } from './desktop-chat-tool-details.js';
import { ChatToolLinks, type ChatToolPositions } from './desktop-chat-tool-links.js';
import { endOfChatTurn, type ChatCompletedTurns } from './desktop-chat-turns.js';
import { editableChatPrompt } from './desktop-chat-edit.js';
import { chatAgentEntry } from './desktop-chat-agent-tools.js';
import { mergeTranscriptRows } from '../agent-runtime/transcript-order.js';
import { chatItemFailed, commandExecution } from './desktop-chat-tool-outcome.js';

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
  /** Live records actually included in this bounded projection, in display order. */
  readonly projectedLive?: SessionChatItem[];
  readonly settling?: readonly AgentTranscriptItem[];
  readonly includeLeadingPrompt?: boolean;
  readonly linkToolReceipts?: boolean;
  readonly completedTurns?: ChatCompletedTurns;
  readonly summarizeRecent?: boolean;
  readonly toolDetails?: ChatToolDetails;
  readonly keepTurnId?: string;
  readonly liveTurn?: boolean;
  readonly promptEditing?: boolean;
}

interface Candidate {
  readonly item: AgentTranscriptItem;
  readonly historyIndex: number;
  readonly historyEnd: number;
  readonly summary?: SessionChatItem;
}

/** A raw window can carry the same outcome as a compact turn once it has
 * the whole saved span. Partial windows and live rows use their available evidence. */
function savedWindowTurnChanges(
  ordered: readonly Candidate[], position: number, history: readonly AgentTranscriptItem[],
  liveItems: ReadonlyMap<string, AgentTranscriptItem>, live: boolean,
) {
  const prompt = ordered[position];
  if (liveItems.has(prompt.item.id)) return undefined;
  const rows = [prompt.item];
  let through = prompt.historyEnd;
  for (let index = position + 1; index < ordered.length; index++) {
    const candidate = ordered[index];
    if (candidate.item.kind === 'user') break;
    if (liveItems.has(candidate.item.id)) return undefined;
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
  limit: number, index: ChatHistoryIndex, liveIds: ReadonlySet<string>, options: ChatWindowOptions,
  projectTool?: ProjectChatTool,
): readonly Candidate[] {
  const turns = options.completedTurns;
  const result: Candidate[] = [];
  const step = forward ? 1 : -1;
  let position = forward ? start : end - 1;
  let summaryCount = 0;
  const lastPrompt = turns && options.liveTurn && end === history.length
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
          result.push({ item: history[first], summary, historyIndex: first, historyEnd: through - 1 });
          summaryCount++;
          position = forward ? through : first - 1;
          continue;
        }
      }
    }
    result.push({ item: history[position], historyIndex: position, historyEnd: position });
    position += step;
  }
  return forward ? result : result.reverse();
}

/** Take bounded candidates before projecting. Keep source offsets so finding a
 * page's prompt never requires scanning back from the end of the transcript. */
export function chatWindow(
  savedHistory: readonly AgentTranscriptItem[],
  live: readonly AgentTranscriptItem[],
  options: ChatWindowOptions = {},
) {
  const { before, following, loadingMode, changesCache, mediaCache } = options;
  const wideWindow = loadingMode === 'window' && !before && !following;
  // Adjacent pages overlap the renderer's retained 320-record window.
  const limit = wideWindow ? 320 : 80;
  const byteLimit = wideWindow ? 2 * 1024 * 1024 : 512 * 1024;
  const candidateLimit = limit * 2;
  const cursor = following ?? before;
  const liveOnly = !savedHistory.length && options.includeLeadingPrompt === false && !cursor;
  const liveTail = liveOnly && live.length > candidateLimit ? live.slice(-candidateLimit) : live;
  const settling = options.settling;
  const { rows: history, liveItems, savedItems } = mergeTranscriptRows(savedHistory,
    settling?.length ? [...settling, ...liveTail] : liveTail);
  const streamingIds = settling?.length ? new Set(liveTail.map(item => item.id)) : liveItems;
  // Offsets in a merged transcript change independently of the saved revision.
  const historyIndex = (history === savedHistory && options.historyIndex) || new ChatHistoryIndex();
  historyIndex.align(history);
  const historyPosition = cursor ? historyIndex.position(history, cursor, following ? 'following' : 'before') : history.length;
  if (historyPosition < 0) return null;
  const historyStart = following ? historyPosition + 1 : 0;
  const historyEnd = before ? historyPosition : history.length;
  const toolPage = options.toolDetails?.projectPage();
  const saved = historyCandidates(
    history, historyStart, historyEnd, !!following,
    options.completedTurns ? limit : candidateLimit, historyIndex, new Set(liveItems.keys()), options, toolPage?.project,
  );
  const candidates = new Map<string, Candidate>();
  for (const candidate of saved) {
    const previous = candidates.get(candidate.item.id);
    candidates.set(candidate.item.id, previous && !candidate.summary && !previous.summary
      ? { ...candidate, historyIndex: previous.historyIndex } : candidate);
  }
  const moreHistory = !!following && (saved.at(-1)?.historyEnd ?? historyStart - 1) + 1 < history.length;

  const ordered = [...candidates.values()];
  const links = new ChatToolLinks(ordered.map(({ item }) => item));
  if (toolPage || options.linkToolReceipts) {
    links.findMissing(settling ?? []);
    links.findMissing(live);
    const savedIndex = options.historyIndex ?? historyIndex;
    savedIndex.align(savedHistory);
    savedIndex.fillTools(savedHistory, links);
  }
  const editable = (item: AgentTranscriptItem) => {
    const saved = savedItems.get(item.id) ?? (!liveItems.has(item.id) ? item : undefined);
    return options.promptEditing && saved && editableChatPrompt(saved);
  };
  const items: SessionChatItem[] = [];
  let bytes = 0;
  let edge = following ? 0 : ordered.length;
  while ((following ? edge < ordered.length : edge > 0) && items.length < limit) {
    const position = following ? edge : edge - 1;
    const { item: raw, summary } = ordered[position];
    const peer = links.peer(raw);
    const call = raw.kind === 'tool_result' ? peer : undefined;
    let item: SessionChatItem = summary ?? toolPage?.activity(raw, peer) ?? chatItem(raw, call, changesCache, mediaCache);
    if (raw.kind === 'tool_use' && peer && !toolPage) {
      const agent = chatAgentEntry(raw, peer);
      if (agent) item = { ...item, agent };
    }
    if (options.linkToolReceipts && raw.kind === 'tool_use' && peer)
      item = { ...item, receipt: { id: peer.id, error: chatItemFailed(peer, commandExecution(peer, raw)) } };
    if (!summary && raw.kind === 'user') {
      const turnChanges = savedWindowTurnChanges(ordered, position, history, liveItems, !!options.liveTurn);
      if (turnChanges) item = { ...item, turnChanges };
    }
    if (!summary && raw.turnChanges && !raw.turnChanges.evidence) {
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
    const liveItem = item;
    if (editable(raw))
      item = { ...item, editable: true };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > byteLimit) break;
    if (summary) historyIndex.remember(item.id, ordered[position].historyIndex);
    items.push(item);
    if (streamingIds.has(raw.id)) options.projectedLive?.push(liveItem);
    edge += following ? 1 : -1;
  }
  if (!following) {
    items.reverse();
    options.projectedLive?.reverse();
  }
  const first = ordered[following ? 0 : edge];
  const last = ordered[following ? edge - 1 : ordered.length - 1];
  let prompt: AgentTranscriptItem | undefined;
  if (items.length) {
    toolPage?.commit();
    historyIndex.remember(first.item.id, first.historyIndex);
    historyIndex.remember(last.summary?.completedTurn?.endId ?? last.item.id, last.historyEnd, 'following');
    if (options.includeLeadingPrompt !== false && first.item.kind !== 'user')
      prompt = historyIndex.promptBefore(history, first.historyIndex);
  }
  return {
    items,
    leadingPrompt: prompt ? {
      ...chatItem(prompt, undefined, changesCache, mediaCache),
      ...(editable(prompt) ? { editable: true as const } : {}),
    } : null,
    before:
      following || edge > 0 || (saved[0]?.historyIndex ?? historyEnd) > 0 || liveTail !== live
        ? items[0]?.id ?? null : null,
    next: before || (following && (edge < ordered.length || moreHistory))
      ? last?.summary?.completedTurn?.endId ?? items.at(-1)?.id ?? null : null,
  };
}
