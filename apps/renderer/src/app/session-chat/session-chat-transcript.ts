import { parseBrowserElements, sessionChatToolStatus, type BrowserElementContext } from '@elevenex/shared';

/** Pairs a recorded image with the element it shows, by its exact attachment name. */
function elementOf(elements: readonly BrowserElementContext[], caption: string) {
  const element = elements.find(row => row.attachment === caption);
  return element ? { element: element.reference, marker: element.marker } : {};
}
import type { SessionChatItem, SessionChatState } from "@elevenex/shared";
import type { ChatExchange, WorkStep } from "../conversation";
import { completedTurnRecords, type OpenTurnWork } from "./session-chat-turn-work";
import { reconcileClaudeBlocks } from "./session-chat-claude-blocks";
import {
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
function withPendingPrompt(
  items: readonly SessionChatItem[],
  pending: PendingChatPrompt,
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
  const start = pendingPromptStart(items, pending);
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
  for (const item of reconciled.items) {
    if (item.kind === "user") {
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
  const retained = new Map<string, ProjectedTurn>();
  const exchanges = groups.map((group, index): ChatExchange => {
    const completed = group.promptItem?.completedTurn;
    const entry = work?.get(group.id);
    const activity = completed && entry?.revision === completed.revision ? entry : undefined;
    const replyStart = completed && activity?.items ? activity.replyOffset ?? completed.beforeReply : 0;
    const turnId = activity?.replyOffset === undefined ? undefined : group.id;
    const records = completed ? completedTurnRecords(completed, activity) : group.items;
    const current = atLiveTail && index === groups.length - 1;
    const live =
      !completed && current &&
      (state?.phase === "running" || state?.phase === "waiting");
    const source = group.promptItem ? [group.promptItem, ...records] : records;
    const author = state?.providers?.find(provider => provider.id === state.provider)?.label ?? state?.provider ?? 'Agent';
    const signature = JSON.stringify([
      current ? state?.phase : 'idle',
      current ? state?.error : '',
      live && !!state?.permission, live && !!state?.question,
      state?.provider, author, fresh.has(group.id), records.map(renderId),
    ]);
    const previous = cache?.turns.get(group.id);
    const ownPending = group.id === pending?.id ? pending : undefined;
    if (previous?.signature === signature && previous.pending === ownPending && previous.work === activity &&
        previous.source.length === source.length && source.every((item, i) => item === previous.source[i])) {
      retained.set(group.id, previous);
      return previous.exchange;
    }
    const toolIds = new Set(
      records
        .filter((item) => item.kind === "tool_use")
        .map((item) => item.toolId ?? item.id),
    );
    const results = new Map(
      records
        .filter((item) => item.kind === "tool_result")
        .map((item) => [item.toolId ?? item.id, item]),
    );
    // Keep the latest text visible, with work on either side in source order.
    // Tool receipts stay paired with their calls, even when they arrive late.
    let finalEnd = completed ? replyStart + completed.reply.length : 0;
    let lastActivity: SessionChatItem | undefined;
    for (let index = completed ? -1 : records.length - 1; index >= 0; index--) {
      const item = records[index];
      if (!item) continue;
      if (!lastActivity && item.kind !== "system") lastActivity = item;
      if (item.kind === "assistant" && messageText(item).trim()) {
        finalEnd = index + 1;
        break;
      }
    }
    let finalStart = completed ? replyStart : finalEnd;
    while (!completed && finalStart > 0 && records[finalStart - 1]?.kind === "assistant")
      finalStart--;
    const followingIds = new Set(
      records.slice(finalEnd).map(renderId),
    );
    const steps: WorkStep[] = records
      .filter((_item, index) => index < finalStart || index >= finalEnd)
      .flatMap((item): WorkStep[] => {
        const pairedResult = item.kind === 'tool_result' && !!item.toolId && toolIds.has(item.toolId);
        if (item.kind === "system" && item.changes && !item.text.trim())
          return [];
        const result = item.kind === 'tool_use' ? results.get(item.toolId ?? item.id) : undefined;
        const running = live && ((item.kind === 'tool_use' && !result && !item.receipt) ||
          (item.kind === 'thinking' && item.id === records.at(-1)?.id));
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
            const status = sessionChatToolStatus(item.error, result?.error ?? receipt?.error, live);
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
                status,
              },
            ];
          }
          if (item.kind === "tool_result") {
            const media = !item.error
              ? item.media?.filter(preview => preview.inline && preview.kind !== 'file')
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
                  : live &&
                      item.kind === "thinking" &&
                      item.id === records.at(-1)?.id
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
    const answer = records.slice(finalStart, finalEnd).map(messageText).join("\n\n");
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
      mentions: group.mentions,
      attachments: group.id === pending?.id ? pending.attachments : group.attachments,
      time: group.time,
      isNew: fresh.has(group.id),
      streaming:
        live &&
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
