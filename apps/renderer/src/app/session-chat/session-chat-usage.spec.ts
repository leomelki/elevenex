import { describe, expect, it } from "vitest";
import type { SessionChatPlanUsage } from "@elevenex/shared";
import { sessionPlanUsage } from "./session-chat-usage";

describe("session subscription display", () => {
  const now = Date.now();
  const usage: SessionChatPlanUsage = {
    provider: "codex",
    planName: "Plus",
    status: "warning",
    updatedAt: new Date(now).toISOString(),
    windows: [
      {
        id: "secondary",
        label: "Weekly limit",
        remainingPercentage: 12,
        resetsAt: (now + 600_000) / 1000,
      },
    ],
  };
  it("preserves a lone weekly or model-specific window without adding a 5-hour allowance", () => {
    expect(sessionPlanUsage(usage, now)).toMatchObject({
      name: "Codex plan",
      tier: "Plus",
      windows: [
        { id: "secondary", label: "Weekly limit", weekly: true, left: 0.12 },
      ],
    });
    expect(sessionPlanUsage(undefined, now)).toBeUndefined();
    expect(sessionPlanUsage({ ...usage, windows: [] }, now)).toBeUndefined();
  });
  it("keeps exhausted quota after its reset until the provider reports fresh usage", () => {
    const plan = sessionPlanUsage(
      {
        ...usage,
        status: "exhausted",
        windows: [
          {
            ...usage.windows[0]!,
            remainingPercentage: 0,
            resetsAt: (now - 10) / 1000,
          },
        ],
      },
      now,
    );
    expect(plan?.exhausted).toBe(true);
    expect(plan?.windows?.[0]?.left).toBe(0);
    expect(plan?.windows?.[0]?.reset).toContain("awaiting usage update");
  });
});
