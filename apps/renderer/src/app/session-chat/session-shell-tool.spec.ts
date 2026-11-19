import { describe, expect, it } from "vitest";
import type { SessionChatItem } from "@elevenex/shared";
import { presentSessionTool } from "./session-chat-tools";
import { chatExchanges } from "./session-chat-transcript";

const item = (extra: Partial<SessionChatItem> = {}): SessionChatItem => ({
  id: "call",
  kind: "tool_use",
  toolId: "shell",
  toolName: "Bash",
  toolKind: "bash",
  input: JSON.stringify({
    cmd: "pnpm test\npnpm lint",
    workdir: "/workspace/project",
    description: "Check the changes",
  }),
  text: "",
  timestamp: "2026-11-15T12:00:00Z",
  error: false,
  truncated: false,
  ...extra,
});
const result = (value: unknown, extra: Partial<SessionChatItem> = {}) =>
  item({
    id: "result",
    kind: "tool_result",
    text: typeof value === "string" ? value : JSON.stringify(value),
    ...extra,
  });

describe("desktop shell receipts", () => {
  it("preserves both streams, native facts, duration, and multiline commands", () => {
    expect(
      presentSessionTool(
        item(),
        result(
          {
            stdout: "\u001b[32m12 passed\u001b[0m",
            stderr: "warning",
            exit_code: 0,
            duration_ms: 65000,
          },
          { execution: { exitCode: 1, cwd: "/native" } },
        ),
      ).shell,
    ).toMatchObject({
      command: "pnpm test\npnpm lint",
      directory: "/native",
      description: "Check the changes",
      output: "\u001b[32m12 passed\u001b[0m\nwarning",
      exitCode: 1,
      failed: true,
      duration: "1m 5s",
    });
  });
  it("does not hide output fallbacks, malformed JSON, or legitimate command text", () => {
    expect(
      presentSessionTool(
        item(),
        result({ stdout: "", output: "fallback", stderr: "problem" }),
      ).shell?.output,
    ).toBe("fallback\nproblem");
    expect(presentSessionTool(item(), result("{truncated")).shell?.output).toBe(
      "{truncated",
    );
    expect(
      presentSessionTool(item(), result("kept\nExit code: 1\n")).shell?.failed,
    ).toBe(false);
    expect(
      presentSessionTool(item({ input: '"git status"' })).shell?.command,
    ).toBe("git status");
    expect(
      presentSessionTool(item(), result("kept\nExit code: 1\n")).shell?.output,
    ).toBe("kept\nExit code: 1\n");
  });
  it("uses native/nonzero exits and interruptions in the timeline even when the harness omits error", () => {
    for (const extra of [
      { execution: { exitCode: 2 } },
      { execution: { interrupted: true } },
    ]) {
      const steps = chatExchanges(
        [
          item({ id: "prompt", kind: "user", text: "Test it" }),
          item(),
          result("stopped", extra),
        ],
        null,
        new Set(),
      )[0]?.steps;
      expect(steps?.find((step) => step.id === "call")?.status).toBe("failed");
    }
    expect(presentSessionTool(item(), result({ interrupted: true })).meta).toBe(
      "Interrupted",
    );
  });
  it("bounds large receipts and marks shortened source instead of silently hiding it", () => {
    const presentation = presentSessionTool(
      item(),
      result({ stdout: "a".repeat(110_000) + "final", exit_code: 0 }),
    );
    expect(presentation.shell?.output).toHaveLength(100_000);
    expect(presentation.shell?.output.endsWith("final")).toBe(true);
    expect(presentation.shell?.outputShortened).toBe(true);
    const step = chatExchanges(
      [item(), result({ stdout: "a".repeat(110_000) })],
      null,
      new Set(),
    )[0]?.steps?.find((step) => step.id === "call");
    expect(step?.fullContent?.outputId).toBe("result");
    expect(
      presentSessionTool(item(), result("", { truncated: true })).shell
        ?.outputShortened,
    ).toBe(true);
  });
});
