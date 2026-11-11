import { describe, expect, it } from "vitest";
import type {
  SessionChatBackgroundWork,
  SessionChatWorkEvent,
} from "@elevenex/shared";
import {
  activitySections,
  eventRowView,
  formatAgo,
  formatElapsed,
  formatUsage,
  workRowView,
} from "./session-activity-model";

const work = (
  patch: Partial<SessionChatBackgroundWork> = {},
): SessionChatBackgroundWork => ({
  id: "subagent:a",
  kind: "agent",
  label: "Review concurrency · reviewer",
  detail: "Checking retry-claims.ts",
  startedAt: "2026-11-11T10:00:00.000Z",
  stoppable: true,
  orphaned: false,
  ...patch,
});
const event = (
  patch: Partial<SessionChatWorkEvent> = {},
): SessionChatWorkEvent => ({
  id: "hook:1",
  kind: "hook",
  tone: "danger",
  title: "PostToolUse:Edit failed",
  detail: "exit 2",
  at: "2026-11-11T10:00:00.000Z",
  ...patch,
});

describe("session activity model", () => {
  it("formats durations, relative times and reported usage compactly", () => {
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(4 * 60_000 + 30_000)).toBe("4m");
    expect(formatElapsed(65 * 60_000)).toBe("1h 5m");
    expect(formatAgo(10_000)).toBe("now");
    expect(formatAgo(12 * 60_000)).toBe("12m ago");
    expect(formatAgo(3 * 3_600_000)).toBe("3h ago");
    expect(formatUsage(work({ tokens: 18_400, toolUses: 1 }))).toBe(
      "18.4k tokens · 1 tool",
    );
    expect(formatUsage(work())).toBe("");
  });

  it("separates work that needs a decision and keeps the backend's order", () => {
    const sections = activitySections({
      running: [
        work({ id: "subagent:w", status: "waiting" }),
        work({ id: "subagent:r", status: "running" }),
        work({ id: "task:t", kind: "task", status: undefined }),
      ],
      recent: [],
    });
    expect(sections.needsYou.map((row) => row.item.id)).toEqual([
      "subagent:w",
    ]);
    expect(sections.running.map((row) => row.item.id)).toEqual([
      "subagent:r",
      "task:t",
    ]);
  });

  it("splits a reported role from the title and falls back to the label", () => {
    expect(
      workRowView(work({ title: "Review concurrency", role: "reviewer" })),
    ).toMatchObject({ title: "Review concurrency", role: "reviewer" });
    // Older engines only send the joined label; never guess by parsing it.
    expect(workRowView(work({ role: "reviewer" }))).toMatchObject({
      title: "Review concurrency · reviewer",
      role: "",
    });
  });

  it("colours only exceptions and names uncommon live states", () => {
    const running = workRowView(work({ status: "running" }));
    expect(running).toMatchObject({ glyph: "running", tag: null });
    expect(
      workRowView(work({ status: "waiting", detail: "" })),
    ).toMatchObject({
      glyph: "attention",
      tag: null,
      summary: "Waiting for your decision",
    });
    expect(workRowView(work({ orphaned: true })).tag).toMatchObject({
      text: "Left behind",
      tone: "attention",
    });
    expect(workRowView(work({ status: "pending" })).tag).toMatchObject({
      text: "Starting",
      tone: "neutral",
    });
  });

  it("offers inspection and controls only when the harness supports them", () => {
    expect(workRowView(work({ inspectable: true })).inspectable).toBe(false);
    expect(
      workRowView(work({ inspectable: true, agentId: "a" })).inspectable,
    ).toBe(true);
    expect(workRowView(work({ stoppable: false })).hasControls).toBe(false);
    expect(
      workRowView(work({ stoppable: false, canBackground: true })).hasControls,
    ).toBe(true);
  });

  it("shows failure output as code and clamps only long output", () => {
    expect(eventRowView(event())).toMatchObject({
      icon: "plug",
      output: true,
      long: false,
    });
    expect(
      eventRowView(event({ detail: Array(6).fill("line").join("\n") })).long,
    ).toBe(true);
    expect(
      eventRowView(event({ kind: "compaction", tone: "info", detail: "182k → 41k" })),
    ).toMatchObject({ icon: "shrink", output: false });
    expect(eventRowView(event({ at: null })).at).toBeNull();
  });
});
