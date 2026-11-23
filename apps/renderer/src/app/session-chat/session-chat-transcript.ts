import { parseBrowserElements, sessionChatToolStatus, type BrowserElementContext } from '@elevenex/shared';

/** Pairs a recorded image with the element it shows, by its exact attachment name. */
function elementOf(elements: readonly BrowserElementContext[], caption: string) {
  const element = elements.find(row => row.attachment === caption);
  return element ? { element: element.reference, marker: element.marker } : {};
}
import type { SessionChatItem, SessionChatState } from "@elevenex/shared";
import type { ChatExchange, ToolImage, WorkStep } from "../conversation";
import { completedTurnRecords, type OpenTurnWork } from "./session-chat-turn-work";
import { reconcileClaudeBlocks } from "./session-chat-claude-blocks";
import {
  imageViewCallIds,
  isViewedImageResult,
  presentSessionToolEvidence,
  sessionToolDetailsSource,
  sessionToolKind,
  sessionToolVerb,
} from "./session-chat-tools";

export interface PendingChatPrompt {
  readonly id: string;
  readonly text: string;
  readonly timestamp: string;
  readonly knownIds: ReadonlySet<string>;
  readonly media?: SessionChatItem["media"];
  readonly mentions?: SessionChatItem['mentions'];
  readonly attachments?: ChatExchange["attachments"];
}

interface ProjectedTurn {
  readonly source: readonly SessionChatItem[];
  readonly signature: string;
  readonly pending?: PendingChatPrompt;
  readonly work?: OpenTurnWork;
  readonly exchange: ChatExchange;
}
interface ProjectedStep {
  readonly result?: SessionChatItem;
  readonly pairedResult: boolean;
  readonly running: boolean;
  readonly renderId: string;
  readonly step: WorkStep;
}
interface ProjectionCache {
  turns: ReadonlyMap<string, ProjectedTurn>;
  readonly steps: WeakMap<SessionChatItem, ProjectedStep>;
  claudeRenderIds: ReadonlyMap<string, string>;
  exchanges: readonly ChatExchange[];
}

/** Owned by one conversation. Evicted turns release their source and view data. */
export class ChatTranscriptProjection {
  private cache: ProjectionCache = { turns: new Map(), steps: new WeakMap(), claudeRenderIds: new Map(), exchanges: [] };
  project(items: readonly SessionChatItem[], state: SessionChatState | null,
    fresh: ReadonlySet<string>, pending?: PendingChatPrompt,
    work?: ReadonlyMap<string, OpenTurnWork>, atLiveTail = true): readonly ChatExchange[] {
    return projectExchanges(items, state, fresh, pending, this.cache, work, atLiveTail);
  }
  reconcileSavedBlocks(previous: readonly SessionChatItem[], current: readonly SessionChatItem[]): void {
    const ids = new Set(current.map(item => item.id));
    // Reuse identities of matching streamed blocks without carrying the raw
    // records past an authoritative history replacement.
    const aliases = reconcileClaudeBlocks([...previous.filter(item => !ids.has(item.id)), ...current]).renderIds;
    const retained = new Map(this.cache.claudeRenderIds);
    for (const [id, renderId] of aliases)
      if (ids.has(id) && !ids.has(renderId)) retained.set(id, renderId);
    this.cache.claudeRenderIds = retained;
  }
  clear(): void {
    this.cache = { turns: new Map(), steps: new WeakMap(), claudeRenderIds: new Map(), exchanges: [] };
  }
}

/** A history page can introduce unseen rows before the tail captured at send time. */
export function pendingPromptStart(items: readonly SessionChatItem[], pending: PendingChatPrompt): number {
  for (let index = items.length - 1; index >= 0; index--)
    if (pending.knownIds.has(items[index]!.id)) return index + 1;
  return 0;
}

/** Runtime output may precede the harness's durable user-message receipt. */
export function withPendingPrompt(
  items: readonly SessionChatItem[],
  pending: PendingChatPrompt,
  start = pendingPromptStart(items, pending),
): readonly SessionChatItem[] {
  const prompt: SessionChatItem = {
    id: pending.id,
    kind: "user",
    text: pending.text,
    media: pending.media,
    mentions: pending.mentions,
    timestamp: pending.timestamp,
    toolId: null,
    toolName: null,
    toolKind: null,
    input: "",
    error: false,
    truncated: false,
  };
  return [...items.slice(0, start), prompt, ...items.slice(start)];
}
function epoch(timestamp: string): number | undefined {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}
/** Inline media belongs to the message that produced it. */
function messageText(item: SessionChatItem): string {
  const images = item.error ? [] : (item.media ?? []).filter(media =>
    media.inline && !item.text.includes(`](${media.path})`) && !item.text.includes(`](<${media.path}>)`));
  return [item.text, ...images.map(media => `![${media.caption.replace(/[[\]\r\n]/g, " ")}](${media.path})`)]
    .filter(Boolean).join("\n\n");
}
function viewedImages(result: SessionChatItem): readonly ToolImage[] | undefined {
  if (result.error || !result.media) return;
  return result.media.filter(media => media.inline && (!media.kind || media.kind === 'image'))
    .map(({ id, path, caption }) => ({ itemId: result.id, mediaId: id, path, caption }));
}
function inlineToolPreview(media: NonNullable<SessionChatItem['media']>[number]): boolean {
  return media.inline && media.kind !== 'file';
}

function transcriptToolLinks(items: readonly SessionChatItem[]) {
  const calls = new Map<string, SessionChatItem>();
  const results = new Map<string, SessionChatItem>();
  for (const item of items) {
    if (item.kind === 'tool_use') calls.set(item.toolId ?? item.id, item);
    else if (item.kind === 'tool_result' && item.toolId) results.set(item.toolId, item);
  }
  return { calls, results };
}
/** Preserve chronology, tool/result identities and commentary; a later success never erases a failure. */
export function chatExchanges(
  items: readonly SessionChatItem[],
  state: SessionChatState | null,
  fresh: ReadonlySet<string>,
  pending?: PendingChatPrompt,
): readonly ChatExchange[] {
  return projectExchanges(items, state, fresh, pending);
}

function projectExchanges(
  items: readonly SessionChatItem[],
  state: SessionChatState | null,
  fresh: ReadonlySet<string>,
  pending?: PendingChatPrompt,
  cache?: ProjectionCache,
  work?: ReadonlyMap<string, OpenTurnWork>,
  atLiveTail = true,
): readonly ChatExchange[] {
  const groups: {
    id: string;
    prompt: string;
    mentions?: ChatExchange['mentions'];
    attachments?: ChatExchange["attachments"];
    time: string;
    /** Epoch ms of the prompt; unknown for history that starts mid-turn. */
    startedAt?: number;
    promptItem?: SessionChatItem;
    items: SessionChatItem[];
  }[] = [];
  const reconciled = reconcileClaudeBlocks(pending ? withPendingPrompt(items, pending) : items);
  const renderId = (item: SessionChatItem) =>
    cache?.claudeRenderIds.get(item.id) ?? reconciled.renderIds.get(item.id) ?? item.id;
  let savedThrough = -1;
  let savedTurn: SessionChatItem['completedTurn'];
  for (const [position, item] of reconciled.items.entries()) {
    if (item.kind === "user") {
      savedTurn = item.completedTurn;
      savedThrough = -1;
      // A refresh or adjacent page can overlap a compact turn with its raw
      // source. Only its durable end cursor can prove the full overlap.
      if (savedTurn) {
        for (let i = position + 1; i < reconciled.items.length; i++) {
          const following = reconciled.items[i]!;
          if (following.kind === 'user') break;
          if (following.id === savedTurn.endId) {
            savedThrough = i;
            break;
          }
        }
      }
      const previous = cache?.turns.get(item.id);
      if (previous?.source[0] === item) {
        const { prompt, mentions, attachments, time, startedAt } = previous.exchange;
        groups.push({ id: item.id, promptItem: item, prompt, mentions, attachments,
          time: time ?? '', startedAt, items: [] });
        continue;
      }
      const browser = parseBrowserElements(item.text);
      groups.push({
        promptItem: item,
        id: item.id,
        prompt: browser.text.split('\n').filter(line => !line.startsWith('[') || !item.media?.some(media => line.endsWith(`](<${media.path}>)`))).join('\n').trim(),
        mentions: item.mentions?.map(mention => ({ id: String(mention.sessionId), kind: 'session', label: mention.title })),
        attachments: item.media?.map(media => ({ id: media.id, path: media.path, name: media.caption, kind: media.kind ?? 'image', ...elementOf(browser.elements, media.caption) })),
        time: new Date(item.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        startedAt: epoch(item.timestamp),
        items: [],
      });
    } else {
      if (position <= savedThrough || savedTurn?.reply.some(reply => reply.id === item.id)) continue;
      if (!groups.length || groups.at(-1)?.promptItem?.completedTurn)
        groups.push({
          id: "history-" + item.id,
          prompt: "",
          time: "",
          items: [],
        });
      // Raw activity after a complete saved span can arrive before its new
      // prompt receipt. Do not attribute it to the sealed turn.
      groups.at(-1)?.items.push(item);
    }
  }
  // A steer can introduce a user row before an existing call receives its
  // result. The call still owns the receipt even across that prompt boundary.
  const liveLinks = transcriptToolLinks(groups.flatMap(group => group.items));
  const retained = new Map<string, ProjectedTurn>();
  const exchanges = groups.map((group, index): ChatExchange => {
    const completed = group.promptItem?.completedTurn;
    const entry = work?.get(group.id);
    const activity = completed && entry?.revision === completed.revision ? entry : undefined;
    const replyStart = completed && activity?.items ? activity.replyOffset ?? completed.beforeReply : 0;
    const turnId = activity?.replyOffset === undefined ? undefined : group.id;
    const records = completed ? completedTurnRecords(completed, activity) : group.items;
    const current = atLiveTail && index === groups.length - 1;
    const live = !completed &&
      (state?.phase === "running" || state?.phase === "waiting") &&
      (state.activePromptId ? group.id === state.activePromptId : current);
    // A history slice can belong to the active turn without receiving live rows.
    const liveUpdates = live && atLiveTail;
    const localLinks = transcriptToolLinks(records);
    const links = completed ? localLinks : liveLinks;
    const external: SessionChatItem[] = [];
    if (!completed) {
      for (const item of records) {
        const key = item.toolId ?? item.id;
        const peer = item.kind === 'tool_use' && !localLinks.results.has(key) ? links.results.get(key)
          : item.kind === 'tool_result' && !localLinks.calls.has(key) ? links.calls.get(key) : undefined;
        if (peer) external.push(peer);
      }
    }
    const source = [...(group.promptItem ? [group.promptItem] : []), ...records, ...external];
    const author = state?.providers?.find(provider => provider.id === state.provider)?.label ?? state?.provider ?? 'Agent';
    const signature = JSON.stringify([
      current || live ? state?.phase : 'idle',
      current ? state?.error : '',
      live, liveUpdates, live && !!state?.permission, live && !!state?.question,
      state?.provider, author, fresh.has(group.id), records.map(renderId),
    ]);
    const previous = cache?.turns.get(group.id);
    const ownPending = group.id === pending?.id ? pending : undefined;
    if (previous?.signature === signature && previous.pending === ownPending && previous.work === activity &&
        previous.source.length === source.length && source.every((item, i) => item === previous.source[i])) {
      retained.set(group.id, previous);
      return previous.exchange;
    }
    const viewCalls = imageViewCallIds(external.length ? [...records, ...external] : records);
    const isPairedResult = (item: SessionChatItem): boolean =>
      item.kind === 'tool_result' && !!item.toolId && links.calls.has(item.toolId);
    const isTextReceipt = (item: SessionChatItem): boolean =>
      isPairedResult(item) && (item.error || !item.media?.some(inlineToolPreview));
    const isEmptyAssistant = (item: SessionChatItem): boolean =>
      item.kind === 'assistant' && !item.text.trim() && !item.media?.some(media => media.inline);
    // Keep the latest text visible, with work on either side in source order.
    // Text-only receipts update the original call. Their position cannot
    // interrupt a later thought or split adjacent reply blocks. Media and
    // unpaired results still delimit the surrounding activity.
    let finalEnd = completed ? replyStart + completed.reply.length : 0;
    let progressEnd = 0;
    let lastActivity: SessionChatItem | undefined;
    let lastTimelineItem: SessionChatItem | undefined;
    for (let index = completed ? -1 : records.length - 1; index >= 0; index--) {
      const item = records[index]!;
      if (isTextReceipt(item) || isEmptyAssistant(item)) continue;
      lastTimelineItem ??= item;
      if (item.kind !== "system") lastActivity ??= item;
      if (item.kind === "assistant" && messageText(item).trim()) {
        if (live || item.assistantPhase !== "commentary") {
          finalEnd = index + 1;
          break;
        }
        progressEnd ||= index + 1;
      }
    }
    if (!finalEnd) finalEnd = progressEnd;
    let finalStart = completed ? replyStart : finalEnd;
    const replyPhase = records[finalEnd - 1]?.assistantPhase;
    for (let index = completed ? -1 : finalEnd - 1; index >= 0; index--) {
      const item = records[index]!;
      if (isEmptyAssistant(item)) continue;
      if (item.kind === 'assistant' && item.assistantPhase === replyPhase) finalStart = index;
      else if (!isTextReceipt(item)) break;
    }
    const followingIds = new Set(
      records.slice(finalEnd).map(renderId),
    );
    const steps: WorkStep[] = records
      .filter((_item, index) => index < finalStart || index >= finalEnd)
      .flatMap((item): WorkStep[] => {
        if (isEmptyAssistant(item)) return [];
        const pairedResult = isPairedResult(item);
        const viewedResult = isViewedImageResult(item, viewCalls);
        if (pairedResult && viewedResult) return [];
        if (item.kind === "system" && item.changes && !item.text.trim()) return [];
        const result = item.kind === 'tool_use'
          ? localLinks.results.get(item.toolId ?? item.id) ?? links.results.get(item.toolId ?? item.id) : undefined;
        const running = liveUpdates && ((item.kind === 'tool_use' && !result && !item.receipt) ||
          (item.kind === 'thinking' && item === lastTimelineItem));
        const old = cache?.steps.get(item);
        const id = renderId(item);
        if (old && old.result === result && old.pairedResult === pairedResult &&
          old.running === running && old.renderId === id)
          return [old.step];
        const project = (): WorkStep[] => {
          if (item.kind === "tool_use") {
            const receipt = item.receipt;
            const deferredTool = sessionToolDetailsSource(item, result, turnId);
            const evidence = deferredTool ? undefined : presentSessionToolEvidence(item, result, result ? undefined : receipt?.id);
            const shell = evidence?.presentation.shell;
            const status = sessionChatToolStatus(
              item.error || shell?.failed === true || shell?.interrupted === true,
              result?.error ?? receipt?.error,
              liveUpdates,
            );
            return [
              {
                id: item.id,
                kind: sessionToolKind(item),
                detail: item.toolDetails?.summary ?? evidence?.presentation.summary ?? item.toolName ?? 'Tool',
                verb: sessionToolVerb(item, status === 'running', status === 'failed' || status === 'unknown' ? status : undefined),
                meta:
                  status === "unknown"
                    ? "Completion unknown"
                    : result?.toolDetails?.meta ?? receipt?.toolDetails?.meta ?? item.toolDetails?.meta ?? evidence?.presentation.meta,
                deferredTool,
                ...evidence,
                images: result && isViewedImageResult(result, viewCalls) ? viewedImages(result) : undefined,
                status,
              },
            ];
          }
          if (item.kind === "tool_result") {
            const media = !viewedResult && !item.error
              ? item.media?.filter(inlineToolPreview)
                .map(({ path, caption }) => ({ path, caption }))
              : undefined;
            // Text receipts update the call. Previews stay at the result's
            // position, including when it arrives after another message.
            if (pairedResult) return media?.length ? [{ id, kind: 'media', media }] : [];
            const invocation = item.invocation;
            const deferredTool = sessionToolDetailsSource(item, undefined, turnId);
            return [{
              id,
              kind: invocation ? sessionToolKind(invocation) : "tool",
              detail: invocation?.toolDetails.summary ?? item.toolName ?? "Tool result",
              media,
              images: viewedResult ? viewedImages(item) : undefined,
              status: item.error ? "failed" : "done",
              ...(deferredTool ? {
                verb: invocation ? 'Result' : undefined,
                deferredTool,
                meta: item.toolDetails?.meta,
              } : presentSessionToolEvidence(item)),
            }];
          }
          return [
            {
              id,
              kind:
                item.kind === "thinking"
                  ? "think"
                  : item.kind === "assistant"
                    ? "say"
                    : item.kind === "error"
                      ? "tool"
                      : "note",
              text: messageText(item),
              detail: item.kind === "error" ? item.text : undefined,
              status:
                item.error || item.kind === "error"
                  ? "failed"
                  : running
                    ? "running"
                    : "done",
            },
          ];
        };
        const projected = project();
        if (projected[0]) cache?.steps.set(item, { result, pairedResult, running, renderId: id, step: projected[0] });
        return projected;
      });
    const captured = completed ? completed.changes : group.promptItem?.turnChanges ??
      records.filter(item => item.kind === 'system' && item.changes).at(-1)?.changes;
    const reported = new Map<string, NonNullable<SessionChatItem['changes']>['files'][number]>();
    let sharedChanges = captured?.shared;
    if (!completed && !captured) {
      for (const item of records) {
        if (item.kind !== 'tool_result' || item.error || !item.changes) continue;
        for (const file of item.changes.files) reported.set(file.path, file);
        sharedChanges ??= item.changes.shared;
      }
    }
    const files = captured?.files ?? [...reported.values()];
    const filesTotal = captured?.total ?? files.length;
    const endedAt = completed ? undefined : records.reduce<number | undefined>((latest, item) => {
      const at = epoch(item.timestamp);
      return at === undefined || (latest !== undefined && latest >= at) ? latest : at;
    }, undefined);
    const duration = completed ? completed.duration :
      !live && group.startedAt !== undefined && endedAt !== undefined
        ? Math.max(0, (endedAt - group.startedAt) / 1000)
        : undefined;
    const answer = records.slice(finalStart, finalEnd)
      .filter(item => item.kind === 'assistant' && !isEmptyAssistant(item)).map(messageText).join("\n\n");
    const exchange: ChatExchange = {
      overflow: (completed && activity?.closing ? completed.reply : records)
        // Tool evidence belongs in the work timeline, not below the answer.
        .filter(
          (item) => item.truncated && item.kind !== "tool_use" && item.kind !== "tool_result",
        )
        .map((item) => ({
          id: item.id,
          label: "message",
        })),
      id: group.id,
      prompt: group.prompt,
      promptEditable: group.promptItem?.editable,
      mentions: group.mentions,
      attachments: group.id === pending?.id ? pending.attachments : group.attachments,
      time: group.time,
      isNew: fresh.has(group.id),
      revealOnArrival: false,
      streaming:
        liveUpdates &&
        state?.phase === "running" &&
        !state.permission &&
        !state.question &&
        lastActivity?.kind === "assistant",
      status: live
        ? "live"
        : current && state?.phase === "error"
          ? "failed"
          : "done",
      ...(completed ? { deferredWork: {
        counts: completed.counts,
        failures: completed.failures,
        busy: !!activity?.busy,
        ready: !!activity?.items,
        error: activity?.error,
      } } : {}),
      steps: previous?.exchange.steps.length === steps.length && steps.every((step, i) => step === previous.exchange.steps[i])
        ? previous.exchange.steps : steps,
      duration,
      startedAt: group.startedAt,
      files: previous?.exchange.files?.length === files.length && files.every((file, i) => file === previous.exchange.files?.[i])
        ? previous.exchange.files : files,
      filesTotal,
      reviewAvailable: !!captured?.sources?.length || !!captured?.notice,
      filesDiff: captured?.lineTotals,
      sharedChanges,
      answerBeforeStepId:
        finalEnd > finalStart
          ? steps.find((step) => followingIds.has(step.id))?.id
          : undefined,
      answerId: finalEnd > finalStart ? renderId(records[finalStart]!) : undefined,
      answer,
      // Name the harness as the picker does ("Claude Code", not "claude").
      author,
      harness: state?.provider,
      mark: (state?.provider ?? "EX").slice(0, 2).toUpperCase(),
      error: current ? (state?.error ?? "") : "",
    };
    retained.set(group.id, { source, signature, pending: ownPending, work: activity, exchange });
    return exchange;
  });
  if (!cache) return exchanges;
  cache.turns = retained;
  if (cache.claudeRenderIds.size || reconciled.renderIds.size) {
    const aliases = new Map<string, string>();
    for (const item of reconciled.items) {
      const id = renderId(item);
      if (id !== item.id) aliases.set(item.id, id);
    }
    cache.claudeRenderIds = aliases;
  }
  if (cache.exchanges.length !== exchanges.length || exchanges.some((exchange, i) => exchange !== cache.exchanges[i]))
    cache.exchanges = exchanges;
  return cache.exchanges;
}
