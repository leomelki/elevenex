import { parseBrowserElements, type BrowserElementContext } from '@elevenex/shared';

/** Pairs a recorded image with the element it shows, by its exact attachment name. */
function elementOf(elements: readonly BrowserElementContext[], caption: string) {
  const element = elements.find(row => row.attachment === caption);
  return element ? { element: element.reference, marker: element.marker } : {};
}
import type { SessionChatItem, SessionChatState } from "@elevenex/shared";
import type { ChatExchange, WorkStep } from "../conversation";
import { reconcileClaudeBlocks } from "./session-chat-claude-blocks";
import {
  presentSessionTool,
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
  readonly exchange: ChatExchange;
}
interface ProjectedStep {
  readonly result?: SessionChatItem;
  readonly running: boolean;
  readonly renderId: string;
  readonly step: WorkStep;
}
interface ProjectionCache {
  turns: ReadonlyMap<string, ProjectedTurn>;
  readonly steps: WeakMap<SessionChatItem, ProjectedStep>;
  exchanges: readonly ChatExchange[];
}

/** Owned by one conversation. Evicted turns release their source and view data. */
export class ChatTranscriptProjection {
  private cache: ProjectionCache = { turns: new Map(), steps: new WeakMap(), exchanges: [] };
  project(items: readonly SessionChatItem[], state: SessionChatState | null,
    fresh: ReadonlySet<string>, pending?: PendingChatPrompt): readonly ChatExchange[] {
    return projectExchanges(items, state, fresh, pending, this.cache);
  }
  clear(): void { this.cache = { turns: new Map(), steps: new WeakMap(), exchanges: [] }; }
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
  return [
    ...items.filter((item) => pending.knownIds.has(item.id)),
    prompt,
    ...items.filter((item) => !pending.knownIds.has(item.id)),
  ];
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
  const renderId = (item: SessionChatItem) => reconciled.renderIds.get(item.id) ?? item.id;
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
      if (!groups.length)
        groups.push({
          id: "history-" + item.id,
          prompt: "",
          time: "",
          items: [],
        });
      groups.at(-1)?.items.push(item);
    }
  }
  const retained = new Map<string, ProjectedTurn>();
  const exchanges = groups.map((group, index): ChatExchange => {
    const live =
      index === groups.length - 1 &&
      (state?.phase === "running" || state?.phase === "waiting");
    const source = group.promptItem ? [group.promptItem, ...group.items] : group.items;
    const author = state?.providers?.find(provider => provider.id === state.provider)?.label ?? state?.provider ?? 'Agent';
    const signature = JSON.stringify([
      index === groups.length - 1 ? state?.phase : 'idle',
      index === groups.length - 1 ? state?.error : '',
      live && !!state?.permission, live && !!state?.question,
      state?.provider, author, fresh.has(group.id), group.items.map(renderId),
    ]);
    const previous = cache?.turns.get(group.id);
    const ownPending = group.id === pending?.id ? pending : undefined;
    if (previous?.signature === signature && previous.pending === ownPending &&
        previous.source.length === source.length && source.every((item, i) => item === previous.source[i])) {
      retained.set(group.id, previous);
      return previous.exchange;
    }
    const toolIds = new Set(
      group.items
        .filter((item) => item.kind === "tool_use")
        .map((item) => item.toolId ?? item.id),
    );
    const results = new Map(
      group.items
        .filter((item) => item.kind === "tool_result")
        .map((item) => [item.toolId ?? item.id, item]),
    );
    // Keep the latest text visible, with work on either side in source order.
    // Tool receipts stay paired with their calls, even when they arrive late.
    let finalEnd = 0;
    let lastActivity: SessionChatItem | undefined;
    for (let index = group.items.length - 1; index >= 0; index--) {
      const item = group.items[index];
      if (!item) continue;
      if (!lastActivity && item.kind !== "system") lastActivity = item;
      if (item.kind === "assistant" && messageText(item).trim()) {
        finalEnd = index + 1;
        break;
      }
    }
    let finalStart = finalEnd;
    while (finalStart > 0 && group.items[finalStart - 1]?.kind === "assistant")
      finalStart--;
    const followingIds = new Set(
      group.items.slice(finalEnd).map(renderId),
    );
    const steps: WorkStep[] = group.items
      .filter((_item, index) => index < finalStart || index >= finalEnd)
      .flatMap((item): WorkStep[] => {
        if (
          item.kind === "tool_result" &&
          item.toolId &&
          toolIds.has(item.toolId)
        )
          return [];
        if (item.kind === "system" && item.changes && !item.text.trim())
          return [];
        const result = item.kind === 'tool_use' ? results.get(item.toolId ?? item.id) : undefined;
        const running = live && ((item.kind === 'tool_use' && !result) ||
          (item.kind === 'thinking' && item.id === group.items.at(-1)?.id));
        const old = cache?.steps.get(item);
        const id = renderId(item);
        if (old && old.result === result && old.running === running && old.renderId === id)
          return [old.step];
        const project = (): WorkStep[] => {
          if (item.kind === "tool_use") {
            const presentation = presentSessionTool(item, result);
            const outcome =
              result?.error || item.error
                ? "failed"
                : !result && !live
                  ? "unknown"
                  : undefined;
            return [
              {
                id: item.id,
                kind: sessionToolKind(item),
                detail: presentation.summary,
                verb: sessionToolVerb(item, !result && live, outcome),
                meta:
                  outcome === "unknown"
                    ? "Completion unknown"
                    : presentation.meta,
                presentation,
                fullContent: item.truncated || result?.truncated
                  ? {
                      inputId: item.truncated ? item.id : undefined,
                      outputId: result?.truncated ? result.id : undefined,
                    }
                  : undefined,
                status: outcome ?? (result ? "done" : "running"),
                output: [
                  "Input",
                  item.input || "(none)",
                  result ? "\nOutput\n" + result.text : "",
                  item.truncated || result?.truncated
                    ? "\nDisplay shortened. Full output remains in the harness transcript."
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            ];
          }
          return [
            {
              id: renderId(item),
              kind:
                item.kind === "thinking"
                  ? "think"
                  : item.kind === "assistant"
                    ? "say"
                    : item.kind === "error" || item.kind === "tool_result"
                      ? "tool"
                      : "note",
              text: messageText(item),
              detail:
                item.kind === "error"
                  ? item.text
                  : item.kind === "tool_result"
                    ? (item.toolName ?? "Tool result")
                    : undefined,
              output: item.kind === "tool_result" ? item.text : undefined,
              presentation:
                item.kind === "tool_result"
                  ? presentSessionTool({ ...item, input: "" }, item)
                  : undefined,
              fullContent: item.kind === 'tool_result' && item.truncated
                ? { outputId: item.id }
                : undefined,
              status:
                item.error || item.kind === "error"
                  ? "failed"
                  : live &&
                      item.kind === "thinking" &&
                      item.id === group.items.at(-1)?.id
                    ? "running"
                    : "done",
            },
          ];
        };
        const projected = project();
        if (projected[0]) cache?.steps.set(item, { result, running, renderId: id, step: projected[0] });
        return projected;
      });
    const captured = group.items
      .filter((item) => item.kind === "system" && item.changes)
      .at(-1)?.changes;
    const reported = new Map(
      group.items.flatMap((item) =>
        item.kind === "tool_result" && !item.error
          ? (item.changes?.files ?? []).map(
              (file) => [file.path, file] as const,
            )
          : [],
      ),
    );
    const files = captured?.files ?? [...reported.values()];
    const filesTotal = captured?.total ?? files.length;
    const endedAt = group.items.reduce<number | undefined>((latest, item) => {
      const at = epoch(item.timestamp);
      return at === undefined || (latest !== undefined && latest >= at) ? latest : at;
    }, undefined);
    const duration =
      !live && group.startedAt !== undefined && endedAt !== undefined
        ? Math.max(0, (endedAt - group.startedAt) / 1000)
        : undefined;
    const reply = group.items.slice(finalStart, finalEnd).map(messageText).join("\n\n");
    // Generated artifacts are outcomes, so they must survive collapsed tool
    // evidence. Assistant commentary keeps its own media in source order.
    const generated = new Map<string, string>();
    for (const item of group.items) {
      if (item.kind !== 'tool_result' || item.error) continue;
      for (const media of item.media ?? []) {
        if (!media.inline || reply.includes(`](${media.path})`) || reply.includes(`](<${media.path}>)`)) continue;
        generated.set(media.path, `![${media.caption.replace(/[[\]\r\n]/g, ' ')}](${media.path})`);
      }
    }
    const answer = [reply, ...generated.values()].filter(Boolean).join("\n\n");
    const exchange: ChatExchange = {
      overflow: group.items
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
        : index === groups.length - 1 && state?.phase === "error"
          ? "failed"
          : "done",
      steps: previous?.exchange.steps.length === steps.length && steps.every((step, i) => step === previous.exchange.steps[i])
        ? previous.exchange.steps : steps,
      duration,
      startedAt: group.startedAt,
      files: previous?.exchange.files?.length === files.length && files.every((file, i) => file === previous.exchange.files?.[i])
        ? previous.exchange.files : files,
      filesTotal,
      answerBeforeStepId:
        finalEnd > 0
          ? steps.find((step) => followingIds.has(step.id))?.id
          : undefined,
      answerId: finalEnd > 0 ? renderId(group.items[finalStart]!) : undefined,
      answer,
      // Name the harness as the picker does ("Claude Code", not "claude").
      author,
      harness: state?.provider,
      mark: (state?.provider ?? "EX").slice(0, 2).toUpperCase(),
      error: index === groups.length - 1 ? (state?.error ?? "") : "",
    };
    retained.set(group.id, { source, signature, pending: ownPending, exchange });
    return exchange;
  });
  if (!cache) return exchanges;
  cache.turns = retained;
  if (cache.exchanges.length !== exchanges.length || exchanges.some((exchange, i) => exchange !== cache.exchanges[i]))
    cache.exchanges = exchanges;
  return cache.exchanges;
}
