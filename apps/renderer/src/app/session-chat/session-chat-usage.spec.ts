import { describe, expect, it } from "vitest";
import type { SessionChatModelQuota, SessionChatPlanUsage } from "@elevenex/shared";
import { sessionModelLimits, sessionModelPlan, sessionPlanUsage } from "./session-chat-usage";

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

describe("session per-model quota display", () => {
  const now = Date.now();
  const quota: SessionChatModelQuota = {
    provider: "antigravity",
    tier: "Antigravity Starter Quota",
    updatedAt: new Date(now).toISOString(),
    models: [
      { id: "opus", label: "Claude Opus", remainingPercentage: 0, exhausted: true, resetsAt: (now + 600_000) / 1000 },
      { id: "flash", label: "Gemini Flash", remainingPercentage: 64, exhausted: false, resetsAt: null },
      { id: "sonnet", label: "Claude Sonnet", remainingPercentage: null, exhausted: true, resetsAt: (now - 10) / 1000 },
      { id: "oss", label: "GPT-OSS", remainingPercentage: null, exhausted: false, resetsAt: null },
    ],
  };
  it("ends exhaustion-only reports at their reset and omits models without a reported state", () => {
    const limits = sessionModelLimits(quota, now);
    expect(limits.map((limit) => [limit.id, limit.left])).toEqual([
      ["opus", 0],
      ["flash", 0.64],
    ]);
    expect(limits[0]?.reset).toMatch(/\d/);
    expect(sessionModelLimits(undefined, now)).toEqual([]);
  });
  it("scopes the selected model's quota under the provider heading", () => {
    const [opus] = sessionModelLimits(quota, now);
    expect(sessionModelPlan(quota, opus, "Antigravity")).toEqual({
      name: "Antigravity",
      tier: "Starter Quota",
      exhausted: true,
      scope: "model",
      windows: [opus],
    });
    expect(sessionModelPlan(quota, undefined, "Antigravity")).toBeUndefined();
    expect(sessionModelPlan({ ...quota, tier: "Pro" }, opus, "Antigravity")?.tier).toBe("Pro");
  });
});
