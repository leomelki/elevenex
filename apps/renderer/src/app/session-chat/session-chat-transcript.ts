import type { SessionChatItem, SessionChatState } from "@elevenex/shared";
import type { ChatExchange, WorkStep } from "../conversation";
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
  const groups: {
    id: string;
    prompt: string;
    mentions?: ChatExchange['mentions'];
    attachments?: ChatExchange["attachments"];
    time: string;
    /** Epoch ms of the prompt; unknown for history that starts mid-turn. */
    startedAt?: number;
    items: SessionChatItem[];
  }[] = [];
  for (const item of pending ? withPendingPrompt(items, pending) : items) {
    if (item.kind === "user")
      groups.push({
        id: item.id,
        prompt: item.text.split('\n').filter(line => !line.startsWith('[') || !item.media?.some(media => line.endsWith(`](<${media.path}>)`))).join('\n').trim(),
        mentions: item.mentions?.map(mention => ({ id: String(mention.sessionId), kind: 'session', label: mention.title })),
        attachments: item.media?.map(media => ({ id: media.id, path: media.path, name: media.caption, kind: media.kind ?? 'image' })),
        time: new Date(item.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        startedAt: epoch(item.timestamp),
        items: [],
      });
    else {
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
  return groups.map((group, index): ChatExchange => {
    const live =
      index === groups.length - 1 &&
      (state?.phase === "running" || state?.phase === "waiting");
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
      group.items.slice(finalEnd).map((item) => item.id),
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
        if (item.kind === "tool_use") {
          const result = results.get(item.toolId ?? item.id);
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
            id: item.id,
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
    const answer = group.items.slice(finalStart, finalEnd).map(messageText).join("\n\n");
    return {
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
      steps,
      duration,
      startedAt: group.startedAt,
      files,
      filesTotal,
      answerBeforeStepId:
        finalEnd > 0
          ? steps.find((step) => followingIds.has(step.id))?.id
          : undefined,
      answerId: finalEnd > 0 ? group.items[finalStart]?.id : undefined,
      answer,
      // Name the harness as the picker does ("Claude Code", not "claude").
      author:
        state?.providers?.find((provider) => provider.id === state.provider)
          ?.label ??
        state?.provider ??
        "Agent",
      harness: state?.provider,
      mark: (state?.provider ?? "EX").slice(0, 2).toUpperCase(),
      error: index === groups.length - 1 ? (state?.error ?? "") : "",
    };
  });
}

/** Per-conversation projection cache. Streaming only rebuilds the changed turn;
 * completed turns keep their tool parsing, timestamps and readonly view models.
 * Replacing the map on every projection releases evicted/navigation history. */
export class ChatTranscriptProjection {
  private cache = new Map<string, {
    readonly items: readonly SessionChatItem[];
    readonly stateKey: string;
    readonly fresh: boolean;
    readonly attachments: ChatExchange['attachments'];
    readonly value: ChatExchange;
  }>();

  clear(): void { this.cache.clear(); }

  project(items: readonly SessionChatItem[], state: SessionChatState | null, fresh: ReadonlySet<string>, pending?: PendingChatPrompt): readonly ChatExchange[] {
    const groups: SessionChatItem[][] = [];
    for (const item of pending ? withPendingPrompt(items, pending) : items) {
      if (item.kind === 'user' || !groups.length) groups.push([]);
      groups.at(-1)!.push(item);
    }
    const previous = this.cache;
    const next: typeof this.cache = new Map();
    this.cache = next;
    const author = state?.providers?.find(provider => provider.id === state.provider)?.label;
    return groups.map((group, index) => {
      const first = group[0]!;
      const id = first.kind === 'user' ? first.id : 'history-' + first.id;
      const last = index === groups.length - 1;
      const viewState = last || !state ? state : { ...state, phase: 'idle' as const, error: null, permission: null, question: null };
      const stateKey = JSON.stringify([viewState?.provider, author, viewState?.phase, viewState?.error, !!viewState?.permission, !!viewState?.question]);
      const attachments = id === pending?.id ? pending.attachments : undefined;
      const cached = previous.get(id);
      const entry = cached && cached.stateKey === stateKey && cached.fresh === fresh.has(id) && cached.attachments === attachments
        && cached.items.length === group.length && group.every((item, i) => cached.items[i] === item)
        ? cached : {
          items: group, stateKey, fresh: fresh.has(id), attachments,
          value: { ...chatExchanges(group, viewState, fresh)[0]!, ...(attachments ? { attachments } : {}) },
        };
      next.set(id, entry);
      return entry.value;
    });
  }
}
