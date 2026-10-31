import type { SessionChatItem, SessionChatState } from "@elevenex/shared";
import type { ChatExchange, StepKind, WorkStep } from "../conversation";

const toolKinds: Readonly<Record<string, StepKind>> = {
  read: "read",
  write: "create",
  edit: "edit",
  file_changes: "edit",
  notebook_edit: "edit",
  bash: "run",
  grep: "search",
  glob: "list",
  web_fetch: "web",
  web_search: "web",
  task_agent: "tool",
  todo_write: "note",
};
function toolDetail(item: SessionChatItem): string {
  try {
    const raw: unknown = JSON.parse(item.input);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const input = raw as Record<string, unknown>;
      for (const key of [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
      ])
        if (typeof input[key] === "string") return input[key].slice(0, 500);
    }
  } catch {
    /* Some harnesses expose plain text tool arguments. */
  }
  return item.toolName ?? "Tool";
}
export interface PendingChatPrompt {
  readonly id: string;
  readonly text: string;
  readonly timestamp: string;
  readonly knownIds: ReadonlySet<string>;
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
    time: string;
    items: SessionChatItem[];
  }[] = [];
  for (const item of pending ? withPendingPrompt(items, pending) : items) {
    if (item.kind === "user")
      groups.push({
        id: item.id,
        prompt: item.text,
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
        if (item.kind === "system" && item.changes && !item.text.trim()) return [];
        if (item.kind === "tool_use") {
          const result = results.get(item.toolId ?? item.id);
          return [
            {
              id: item.id,
              kind: toolKinds[item.toolKind ?? ""] ?? "tool",
              detail: toolDetail(item),
              verb: item.toolName ?? "Tool",
              status: result
                ? result.error
                  ? "failed"
                  : "done"
                : live
                  ? "running"
                  : "done",
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
                  : item.kind === "error"
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
    const captured = group.items.filter(item => item.kind === "system" && item.changes).at(-1)?.changes;
    const reported = new Map(group.items.flatMap(item => item.kind === "tool_result" && !item.error ? (item.changes?.files ?? []).map(file => [file.path, file] as const) : []));
    const files = captured?.files ?? [...reported.values()];
    const filesTotal = captured?.total ?? files.length;
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
      answer: group.items
        .slice(finalStart, finalEnd)
        .map((item) => item.text)
        .join("\n\n"),
      author: state?.provider ?? "Agent",
      mark: (state?.provider ?? "EX").slice(0, 2).toUpperCase(),
      error: index === groups.length - 1 ? (state?.error ?? "") : "",
    };
  });
}
