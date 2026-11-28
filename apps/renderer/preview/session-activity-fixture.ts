import type { SessionChatWork } from "@elevenex/shared";

/** Provider-shaped display data; never imported by production. */
export function sessionActivityWork(
  provider: string,
  now = Date.now(),
): SessionChatWork {
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  if (provider === "pi")
    return {
      running: [],
      totalRunning: 0,
      recent: [
        {
          id: "retry:pi",
          kind: "retry",
          tone: "warning",
          title: "Retrying request · attempt 2 of 3",
          detail: "Retry delay 2s · Provider overloaded",
          at: ago(0),
        },
        {
          id: "compact:pi",
          kind: "compaction",
          tone: "info",
          title: "Context compacted",
          detail: "150k → 32k tokens · Automatic",
          at: ago(8),
        },
      ],
    };
  const waitingPlanner =
    provider === "claude"
      ? [
          {
            id: "subagent:planner",
            agentId: "planner",
            kind: "agent" as const,
            label: "Confirm retry window · planner",
            title: "Confirm retry window",
            role: "planner",
            detail: "Waiting for a decision on the retry window",
            status: "waiting" as const,
            background: true,
            inspectable: true,
            startedAt: ago(2),
            stoppable: true,
            orphaned: false,
          },
        ]
      : [];
  return {
    totalRunning: provider === "claude" ? 3 : 2,
    running: [
      ...waitingPlanner,
      {
        id: "subagent:reviewer",
        agentId: "reviewer",
        kind: "agent",
        label:
          provider === "opencode"
            ? "Review transaction boundaries"
            : "Review concurrency · reviewer",
        ...(provider === "opencode"
          ? {}
          : { title: "Review concurrency", role: "reviewer", ...(provider === 'codex' ? { agentName: 'James' } : {}) }),
        detail:
          provider === "codex"
            ? "Waiting for a decision on the retry window"
            : "Checking the unique constraint in retry-claims.ts",
        status: provider === "codex" ? "waiting" : "running",
        background: provider !== "claude",
        inspectable: true,
        canBackground: provider === "claude",
        startedAt: ago(4),
        stoppable: true,
        orphaned: false,
        ...(provider === "opencode"
          ? {}
          : {
              model: provider === "claude" ? "Sonnet" : "worker-model",
              context: { tokens: 28000, limit: 128000, percentage: 22 },
            }),
        ...(provider === "claude" ? { tokens: 18400, toolUses: 9 } : {}),
      },
      {
        id: provider === "claude" ? "task:watch" : "subagent:tests",
        ...(provider === "claude"
          ? {}
          : { agentId: "tests", inspectable: true }),
        kind: provider === "claude" ? "task" : "agent",
        label:
          provider === "claude"
            ? "pnpm test --watch payments"
            : "Verify delayed retries",
        detail:
          provider === "claude"
            ? "Last used Bash"
            : "Running concurrent-request regression tests",
        status: "running",
        background: true,
        startedAt: ago(12),
        stoppable: true,
        orphaned: provider === "claude",
      },
    ],
    recent: [
      ...(provider === "claude"
        ? [
            {
              id: "hook:format",
              kind: "hook" as const,
              tone: "danger" as const,
              title: "PostToolUse:Edit failed",
              detail:
                "exit 2\nprettier: src/payments/client.ts: Unexpected token (42:7)",
              at: ago(1),
            },
          ]
        : []),
      {
        id: "agent:interrupted",
        agentId: "earlier-review",
        kind: "finished",
        tone: "warning",
        title: "Earlier review interrupted",
        detail: "The agent stopped before completing its assignment.",
        at: ago(3),
      },
      {
        id: "compact:context",
        kind: "compaction",
        tone: "info",
        title: "Context compacted",
        detail: provider === "claude" ? "182k → 41.2k tokens · Automatic" : "",
        at: ago(8),
      },
    ],
  };
}
