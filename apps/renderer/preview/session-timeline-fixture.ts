import type { SessionChatItem } from "@elevenex/shared";

export type TimelineScene =
  | "before-message"
  | "after-message"
  | "two-reads"
  | "three-reads"
  | "busy"
  | "long"
  | "finished"
  | "markdown";

const item = (
  id: string,
  kind: SessionChatItem["kind"],
  text = "",
  extra: Partial<SessionChatItem> = {},
): SessionChatItem => ({
  id,
  kind,
  text,
  timestamp: "2026-11-08T10:00:00.000Z",
  toolId: null,
  toolName: null,
  toolKind: null,
  input: "",
  error: false,
  truncated: false,
  ...extra,
});
const call = (
  id: string,
  kind: "bash" | "read" = "bash",
  status: "done" | "running" | "failed" = "done",
): readonly SessionChatItem[] => [
  item(id, "tool_use", "", {
    toolId: id,
    toolName: kind === "read" ? "Read" : "Run command",
    toolKind: kind,
    input: JSON.stringify(
      kind === "read"
        ? { file_path: `src/payments/${id}.ts` }
        : { command: `pnpm test ${id}` },
    ),
  }),
  ...(status === "running"
    ? []
    : [
        item(
          `${id}-result`,
          "tool_result",
          status === "failed"
            ? "The test database is unavailable. The remaining checks can still run."
            : "PASS — all checks passed.",
          { toolId: id, error: status === "failed" },
        ),
      ]),
];
const markdown =
  "The retry path is safe. Read [the design notes](docs/retries.md) or [the provider docs](https://example.com/retries).\n\n```ts\nconst claim = await retries.claim(key);\n```";

/** Stable provider identities reproduce each transition without production test hooks. */
export function sessionTimelineItems(
  scene: TimelineScene,
): readonly SessionChatItem[] {
  const user = item(
    "timeline-prompt",
    "user",
    "Review payment retries, make concurrent requests safe, and verify the change.",
  );
  const intro = item(
    "timeline-intro",
    "assistant",
    "I’ll trace how a retry claims its key, then check concurrent requests.",
  );
  if (
    scene === "before-message" ||
    scene === "after-message" ||
    scene === "markdown"
  )
    return [
      user,
      scene === "markdown" ? { ...intro, text: markdown } : intro,
      ...call("concurrency"),
      ...(scene === "before-message"
        ? []
        : [
            item(
              "timeline-next",
              "assistant",
              "The focused checks pass. I’m verifying recovery after a delayed response.",
            ),
          ]),
    ];
  if (scene === "two-reads" || scene === "three-reads")
    return [
      user,
      intro,
      ...call("retry", "read"),
      ...call("claim", "read"),
      ...(scene === "three-reads" ? call("provider", "read") : []),
    ];
  if (scene === "busy")
    return [
      user,
      intro,
      ...call("watch", "bash", "running"),
      ...call("database", "bash", "failed"),
      ...Array.from({ length: 8 }, (_, n) => call(`check-${n}`)).flatMap(
        (items) => items,
      ),
      item(
        "timeline-next",
        "assistant",
        "The provider checks pass. The watcher is still running; the database check needs a local fixture.",
      ),
    ];
  return [
    user,
    intro,
    ...Array.from({ length: 20 }, (_, n) => [
      ...call(`check-${n}`),
      ...(n === 5 || n === 12
        ? [
            item(
              `timeline-progress-${n}`,
              "assistant",
              n === 5
                ? "Concurrent requests now share one atomic claim."
                : "Delayed responses preserve the original result. I’m checking the last edge cases.",
            ),
          ]
        : []),
    ]).flat(),
    item(
      "timeline-next",
      "assistant",
      "All 20 checks pass. Concurrent retries share the original result.",
    ),
  ];
}
