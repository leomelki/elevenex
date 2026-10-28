import type { SessionChatItem, SessionChatState } from "@elevenex/shared";
import type { ChatExchange, StepKind, WorkStep } from "../conversation";

const toolKinds: Readonly<Record<string, StepKind>> = {
  read: "read",
  write: "create",
  edit: "edit",
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
/** Preserve chronology, tool/result identities and commentary; a later success never erases a failure. */
export function chatExchanges(
  items: readonly SessionChatItem[],
  state: SessionChatState | null,
  fresh: ReadonlySet<string>,
): readonly ChatExchange[] {
  const groups: {
    id: string;
    prompt: string;
    time: string;
    items: SessionChatItem[];
  }[] = [];
  for (const item of items) {
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
    // Only the final contiguous assistant response belongs below the work summary.
    // Earlier commentary stays in its chronological position among tool calls.
    let finalStart = group.items.length;
    while (finalStart > 0 && group.items[finalStart - 1]?.kind === "assistant")
      finalStart--;
    const steps: WorkStep[] = group.items
      .slice(0, finalStart)
      .flatMap((item): WorkStep[] => {
        if (
          item.kind === "tool_result" &&
          item.toolId &&
          toolIds.has(item.toolId)
        )
          return [];
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
      status: live
        ? "live"
        : index === groups.length - 1 && state?.phase === "error"
          ? "failed"
          : "done",
      steps,
      answer: group.items
        .slice(finalStart)
        .map((item) => item.text)
        .join("\n\n"),
      author: state?.provider ?? "Agent",
      mark: (state?.provider ?? "EX").slice(0, 2).toUpperCase(),
      error: index === groups.length - 1 ? (state?.error ?? "") : "",
    };
  });
}
