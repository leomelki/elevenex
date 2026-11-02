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
        .filter((item) => item.kind === "tool_use" && item.toolId)
        .map((item) => item.toolId),
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
      if (item.kind === "assistant" && item.text.trim()) {
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
            text: item.text,
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
    const answer = group.items.slice(finalStart, finalEnd).map(item => item.text).join("\n\n");
    const attachments = group.items.filter(item => !item.error).flatMap(item => item.media ?? [])
      .filter(media => media.inline && !answer.includes(`](${media.path})`));
    return {
      overflow: group.items
        .filter((item) => item.truncated)
        .map((item) => ({
          id: item.id,
          label:
            item.kind === "tool_use"
              ? "tool input"
              : item.kind === "tool_result"
                ? "tool output"
                : "message",
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
      files,
      filesTotal,
      answerBeforeStepId:
        finalEnd > 0
          ? steps.find((step) => followingIds.has(step.id))?.id
          : undefined,
      answer: [answer, ...attachments.map(media => `![${media.caption.replace(/[[\]\r\n]/g, " ")}](${media.path})`)].filter(Boolean).join("\n\n"),
      author: state?.provider ?? "Agent",
      mark: (state?.provider ?? "EX").slice(0, 2).toUpperCase(),
      error: index === groups.length - 1 ? (state?.error ?? "") : "",
    };
  });
}
