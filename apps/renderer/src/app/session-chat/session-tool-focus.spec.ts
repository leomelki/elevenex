import { describe, expect, it } from "vitest";
import type { SessionChatItem } from "@elevenex/shared";
import { presentSessionTool } from "./session-chat-tools";

function call(kind: string, input: unknown): SessionChatItem {
  return {
    id: "tool",
    kind: "tool_use",
    text: "",
    timestamp: "2026-10-28T12:00:00Z",
    toolId: "tool",
    toolName: kind,
    toolKind: kind,
    input: JSON.stringify(input),
    error: false,
    truncated: false,
  };
}
function receipt(value: unknown, error = false): SessionChatItem {
  return {
    ...call("", {}),
    id: "result",
    kind: "tool_result",
    text: typeof value === "string" ? value : JSON.stringify(value),
    error,
  };
}
const primaryText = (
  presentation: ReturnType<typeof presentSessionTool>,
): string => JSON.stringify(presentation.preview);

describe("focused session tool evidence", () => {
  it("shows the command's useful output tail and keeps execution metadata in Details", () => {
    const output = Array.from({ length: 20 }, (_, i) =>
      i === 19 ? "12 tests passed" : `test ${i + 1} passed`,
    ).join("\n");
    const presentation = presentSessionTool(
      call("bash", {
        command: "pnpm test",
        cwd: "/workspace",
        description: "Check retry safety",
      }),
      receipt({ stdout: output, exit_code: 0 }),
    );
    expect(presentation.preview).toHaveLength(1);
    expect(primaryText(presentation)).toContain("12 tests passed");
    expect(primaryText(presentation)).not.toContain("test 1 passed");
    expect(primaryText(presentation)).not.toContain("pnpm test");
    expect(primaryText(presentation)).not.toContain("/workspace");
    expect(presentation.previewNotice).toBe("14 more lines");
    expect(JSON.stringify(presentation.blocks)).toContain("/workspace");
    expect(presentation.preview?.[0]?.title).toBeUndefined();
  });
  it("shows a few literal read lines and compact edit evidence instead of repeated paths", () => {
    const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const read = presentSessionTool(
      call("read", { path: "src/a.ts", offset: 0, limit: 30 }),
      receipt(file),
    );
    expect(read.preview?.[0]).toMatchObject({
      kind: "code",
      text: file.split("\n").slice(0, 6).join("\n"),
    });
    expect(primaryText(read)).not.toContain("src/a.ts");
    expect(read.previewNotice).toBe("24 more lines");
    const edit = presentSessionTool(
      call("edit", {
        path: "src/a.ts",
        old_string: file,
        new_string: "one\ntwo\nthree\nfour\nfive",
      }),
      receipt("Updated"),
    );
    expect(edit.preview?.[0]).toMatchObject({
      kind: "diff",
      before: "line 1\nline 2\nline 3",
      after: "one\ntwo\nthree",
    });
    expect(edit.preview).toHaveLength(1);
  });
  it("chooses the first two changed-file hunks and retains the complete patches in Details", () => {
    const patch =
      "@@ -1,8 +1,8 @@\n context\n-old\n+new\n rest\n more\n even more\n final";
    const presentation = presentSessionTool(
      call("file_changes", {
        changes: [
          { path: "one.ts", diff: patch },
          { path: "two.ts", diff: patch },
          { path: "three.ts", diff: patch },
        ],
      }),
      receipt("Applied"),
    );
    expect(presentation.preview).toHaveLength(2);
    expect(
      presentation.preview?.every(
        (block) => block.kind === "patch" && block.text.includes("-old\n+new"),
      ),
    ).toBe(true);
    expect(primaryText(presentation)).not.toContain("three.ts");
    expect(JSON.stringify(presentation.blocks)).toContain("three.ts");
    expect(presentation.previewNotice).toContain("more lines");
  });
  it("keeps current and pending plan steps, with completed totals in the summary", () => {
    const presentation = presentSessionTool(
      call("todo_write", {
        todos: [
          { content: "Read sources", status: "completed" },
          { content: "Write fix", status: "in_progress" },
          { content: "Run tests", status: "pending" },
        ],
      }),
    );
    expect(presentation.summary).toBe("1 of 3 complete");
    expect(presentation.preview?.[0]).toMatchObject({
      kind: "list",
      items: [
        { label: "Write fix", status: "running" },
        { label: "Run tests", status: "pending" },
      ],
    });
    expect(primaryText(presentation)).not.toContain("Read sources");
    expect(JSON.stringify(presentation.blocks)).toContain("Read sources");
    expect(presentation.previewNotice).toBe("1 more item");
  });
  it("gives web sources a title, domain and short snippet without URLs or extra metadata", () => {
    const presentation = presentSessionTool(
      call("web_search", { query: "retry guide" }),
      receipt({
        results: Array.from({ length: 8 }, (_, i) => ({
          title: `Guide ${i}`,
          url: `https://www.example.com/long/path?q=${i}`,
          snippet: "Keep the same key.",
          published_at: "yesterday",
        })),
      }),
    );
    expect(presentation.preview?.[0]).toMatchObject({
      kind: "list",
      items: [
        { label: "Guide 0", detail: "example.com · Keep the same key." },
        { label: "Guide 1", detail: "example.com · Keep the same key." },
        { label: "Guide 2", detail: "example.com · Keep the same key." },
      ],
    });
    expect(primaryText(presentation)).not.toContain("https://");
    expect(primaryText(presentation)).not.toContain("Published");
    expect(presentation.previewNotice).toBe("5 more items");
  });
  it("curates MCP/unknown outcomes and keeps connection details and arguments out of the primary view", () => {
    const presentation = presentSessionTool(
      call("mcp", {
        server: "issues",
        tool: "get_issue",
        arguments: { issue_id: "A-1", include_history: true },
      }),
      receipt({
        title: "Prevent duplicate charges",
        status: "In progress",
        assignee: "Payments",
        id: "A-1",
        updated_at: "today",
      }),
    );
    expect(presentation.preview?.[0]).toMatchObject({
      kind: "text",
      text: "Prevent duplicate charges",
    });
    expect(presentation.preview?.[1]).toMatchObject({
      kind: "fields",
      fields: [{ label: "Status", value: "In progress" }],
    });
    expect(primaryText(presentation)).not.toContain("Payments");
    expect(primaryText(presentation)).not.toContain("A-1");
    expect(primaryText(presentation)).not.toContain("get_issue");
    expect(primaryText(presentation)).not.toContain("include_history");
    const fallback = presentSessionTool(
      call("unknown", {
        environment: "staging",
        request_id: "internal-42",
        description: "Check deployment health",
      }),
    );
    expect(primaryText(fallback)).toContain("Check deployment health");
    expect(primaryText(fallback)).not.toContain("internal-42");
  });
  it("prioritizes terse error reasons over large proposed changes and stack traces", () => {
    const message =
      "Permission denied\n at service.one\n at service.two\n at service.three\n at service.four";
    const presentation = presentSessionTool(
      call("write", { path: "a.ts", content: "huge\n".repeat(3000) }),
      receipt({ error: { message }, request_id: "internal" }, true),
    );
    expect(presentation.preview).toHaveLength(1);
    expect(primaryText(presentation)).toContain("Permission denied");
    expect(primaryText(presentation)).not.toContain("huge");
    expect(primaryText(presentation)).not.toContain("internal");
    expect(presentation.previewNotice).toBeTruthy();
  });
  it("bounds every canonical family's default preview to two small blocks", () => {
    const kinds = [
      "read",
      "write",
      "edit",
      "file_changes",
      "notebook_edit",
      "bash",
      "grep",
      "glob",
      "web_fetch",
      "web_search",
      "task_agent",
      "agent_collaboration",
      "todo_write",
      "ask_user_question",
      "enter_plan_mode",
      "exit_plan_mode",
      "worktree",
      "lsp",
      "skill",
      "mcp",
      "unknown",
    ];
    for (const kind of kinds) {
      const presentation = presentSessionTool(
        call(kind, {
          path: "a.ts",
          content: "line\n".repeat(500),
          old_string: "before\n".repeat(500),
          new_string: "after\n".repeat(500),
        }),
        receipt({
          title: "Useful result",
          status: "ready",
          request_id: "internal",
        }),
      );
      expect(presentation.preview!.length).toBeLessThanOrEqual(2);
      expect(primaryText(presentation).length).toBeLessThan(1800);
      if (!["read", "bash"].includes(kind))
        expect(primaryText(presentation)).not.toContain("internal");
    }
  });
});
