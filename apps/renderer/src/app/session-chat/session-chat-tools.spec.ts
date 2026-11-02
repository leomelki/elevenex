import { describe, expect, it } from "vitest";
import type { SessionChatItem } from "@elevenex/shared";
import {
  presentSessionTool,
  sessionToolKind,
  sessionToolVerb,
} from "./session-chat-tools";

function tool(
  kind: string,
  input: unknown,
  extra: Partial<SessionChatItem> = {},
): SessionChatItem {
  return {
    id: "call",
    kind: "tool_use",
    text: "",
    timestamp: "2026-10-28T12:00:00Z",
    toolId: "tool",
    toolName: kind,
    toolKind: kind,
    input: typeof input === "string" ? input : JSON.stringify(input),
    error: false,
    truncated: false,
    ...extra,
  };
}
function result(
  text: unknown,
  extra: Partial<SessionChatItem> = {},
): SessionChatItem {
  return tool(
    "",
    {},
    {
      id: "result",
      kind: "tool_result",
      text: typeof text === "string" ? text : JSON.stringify(text),
      ...extra,
    },
  );
}

describe("session tool presentation", () => {
  it("renders native Codex whole-file additions and deletions as before/after diffs", () => {
    const content =
      "Hello! This text file was created to test my file-writing capability.\n";
    for (const kind of ["add", "delete"] as const) {
      for (const nativeKind of [kind, { type: kind }]) {
        const presentation = presentSessionTool(
          tool("file_changes", {
            changes: [
              {
                path: "/workspace/skill-test.txt",
                kind: nativeKind,
                diff: content,
              },
            ],
          }),
          result("Applied"),
        );
        expect(presentation.blocks).toContainEqual({
          kind: "diff",
          title: "/workspace/skill-test.txt",
          before: kind === "delete" ? content : "",
          after: kind === "add" ? content : "",
        });
        expect(presentation.preview?.[0]).toMatchObject({
          kind: "diff",
          title: "/workspace/skill-test.txt",
          before: kind === "delete" ? content.slice(0, -1) : "",
          after: kind === "add" ? content.slice(0, -1) : "",
        });
      }
    }
  });

  it("preserves literal file content and actual unified patch semantics", () => {
    const patch = "@@ -0,0 +1,2 @@\n+++counter\n+--comment\n";
    const unified = presentSessionTool(
      tool("file_changes", {
        changes: [{ path: "literal.ts", kind: { type: "add" }, diff: patch }],
      }),
      result("Applied"),
    );
    expect(
      unified.blocks.find((block) => block.kind === "patch"),
    ).toMatchObject({ text: patch });
    const wholeFile = presentSessionTool(
      tool("file_changes", {
        changes: [
          {
            path: "example.patch",
            kind: "add",
            diff: patch,
            diffFormat: "content",
          },
        ],
      }),
      result("Applied"),
    );
    expect(
      wholeFile.blocks.find((block) => block.kind === "diff"),
    ).toMatchObject({ before: "", after: patch });
    const literal = "++counter\r\n--comment\r\n  keep spaces  \r\n\r\n";
    const created = presentSessionTool(
      tool("file_changes", {
        changes: [{ path: "literal.ts", kind: "add", content: literal }],
      }),
      result("Applied"),
    );
    expect(created.blocks.find((block) => block.kind === "diff")).toMatchObject(
      { before: "", after: literal },
    );
    expect(created.preview?.[0]).toMatchObject({
      kind: "diff",
      after: "++counter\n--comment\n  keep spaces  \n\n",
    });
  });

  it("distinguishes an empty new file from a receipt without inline content", () => {
    const empty = presentSessionTool(
      tool("file_changes", {
        changes: [{ path: "empty.txt", kind: { type: "add" }, diff: "" }],
      }),
      result("Applied"),
    );
    expect(empty.preview?.[0]).toMatchObject({
      kind: "text",
      title: "empty.txt",
      text: "Empty file",
    });
    const absent = presentSessionTool(
      tool("file_changes", { changes: [{ path: "unknown.txt", kind: "add" }] }),
      result("Applied"),
    );
    expect(
      absent.blocks.some(
        (block) => block.kind === "diff" || block.kind === "patch",
      ),
    ).toBe(false);
  });

  it("separates commands, working directory, stderr and native exit status", () => {
    const presentation = presentSessionTool(
      tool("bash", {
        cmd: "pnpm test\npnpm lint",
        cwd: "/workspace",
        description: "Check retry safety",
      }),
      result(
        { stdout: "12 passed", stderr: "Offline cache missing", exit_code: 0 },
        { error: true, execution: { exitCode: 1 } },
      ),
    );
    expect(presentation).toMatchObject({
      summary: "pnpm test",
      meta: "Exit 1",
    });
    expect(presentation.blocks).toContainEqual({
      kind: "code",
      title: "Command",
      text: "pnpm test\npnpm lint",
    });
    expect(presentation.blocks).toContainEqual({
      kind: "code",
      title: "Standard error",
      text: "Offline cache missing",
    });
    expect(JSON.stringify(presentation.blocks)).toContain("/workspace");
  });
  it("keeps read contents inert and identifies its bounded range", () => {
    const presentation = presentSessionTool(
      tool("read", { file_path: "src/a.ts", offset: 0, limit: 20 }),
      result("<script>alert(1)</script>"),
    );
    expect(presentation.summary).toBe("src/a.ts");
    expect(presentation.blocks).toContainEqual({
      kind: "code",
      title: "File content",
      text: "<script>alert(1)</script>",
    });
    expect(JSON.stringify(presentation)).toContain('"value":"0"');
    const jsonFile = '{"healthy":true}';
    expect(
      presentSessionTool(
        tool("read", { path: "package.json" }),
        result(jsonFile),
      ).blocks,
    ).toContainEqual({ kind: "code", title: "File content", text: jsonFile });
    expect(
      presentSessionTool(
        tool("bash", { command: "cat package.json" }),
        result(jsonFile),
      ).blocks,
    ).toContainEqual({ kind: "code", title: "Output", text: jsonFile });
  });
  it("renders replacements, multiple edits, notebook cells and actual patch envelopes", () => {
    const edits = presentSessionTool(
      tool("edit", {
        path: "a.ts",
        edits: [
          { old_string: "old", new_string: "new" },
          { old_string: "before", new_string: "after" },
        ],
      }),
    );
    expect(edits.blocks.filter((block) => block.kind === "diff")).toHaveLength(
      2,
    );
    const patch = presentSessionTool(
      tool("edit", {
        file_path: "a.ts",
        new_string:
          "*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch",
      }),
    );
    expect(patch.blocks.find((block) => block.kind === "patch")?.title).toBe(
      "Proposed patch",
    );
    expect(patch.blocks.some((block) => block.kind === "diff")).toBe(false);
    const notebook = presentSessionTool(
      tool("notebook_edit", {
        notebook_path: "a.ipynb",
        cell_id: "b",
        new_source: "print(1)",
      }),
    );
    expect(notebook.summary).toBe("a.ipynb");
    expect(notebook.blocks).toContainEqual({
      kind: "code",
      title: "Proposed cell content",
      text: "print(1)",
    });
  });
  it("chooses queries, filters, paths, sources and web page actions", () => {
    const search = presentSessionTool(
      tool("grep", { pattern: "retry", path: "src", glob: "*.ts" }),
      result("src/a.ts:4:retry()"),
    );
    expect(search.summary).toBe("retry");
    expect(search.blocks).toContainEqual({
      kind: "code",
      title: "Matches",
      text: "src/a.ts:4:retry()",
    });
    const glob = presentSessionTool(
      tool("glob", { pattern: "*.ts" }),
      result(["a.ts", "b.ts"]),
    );
    expect(glob.blocks).toContainEqual({
      kind: "list",
      title: "Result",
      items: [
        { label: "a.ts", detail: undefined },
        { label: "b.ts", detail: undefined },
      ],
    });
    const web = presentSessionTool(
      tool("web_search", { query: "retry docs" }),
      result({
        results: [
          {
            title: "Retry guide",
            url: "https://example.com/retry",
            snippet: "Use the same key",
          },
        ],
      }),
    );
    expect(web.blocks.find((block) => block.kind === "list")).toMatchObject({
      title: "Sources",
      items: [
        {
          label: "Retry guide",
          detail: "URL: https://example.com/retry · Snippet: Use the same key",
        },
      ],
    });
    expect(
      presentSessionTool(
        tool("web_search", {
          action: {
            type: "findInPage",
            url: "https://example.com",
            pattern: "retry",
          },
        }),
      ).summary,
    ).toBe("https://example.com");
    expect(
      presentSessionTool(tool("web_search", { query: "retry" }), result(""))
        .blocks,
    ).toContainEqual({
      kind: "text",
      title: "Result",
      text: "No result details supplied.",
    });
  });
  it("shows actionable plan progress and agent instructions with outcomes", () => {
    const todo = presentSessionTool(
      tool("todo_write", {
        todos: [
          { content: "Read", status: "completed" },
          { content: "Edit", status: "in_progress" },
          { content: "Test", status: "pending" },
        ],
      }),
    );
    expect(todo.summary).toBe("1 of 3 complete");
    expect(todo.blocks).toContainEqual({
      kind: "list",
      title: "Plan",
      items: [
        { label: "Read", status: "done", detail: undefined },
        { label: "Edit", status: "running", detail: undefined },
        { label: "Test", status: "pending", detail: undefined },
      ],
    });
    const agent = presentSessionTool(
      tool("agent_collaboration", {
        task_name: "review",
        prompt: "Review retry safety",
      }),
      result({
        agent_id: "a",
        agentsStates: { a: { status: "completed", message: "Safe" } },
      }),
    );
    expect(agent.summary).toBe("review");
    expect(agent.blocks).toContainEqual({
      kind: "text",
      title: "Instructions",
      text: "Review retry safety",
    });
    expect(agent.blocks.find((block) => block.kind === "list")).toMatchObject({
      title: "Agent status",
      items: [{ label: "a", detail: "Safe", status: "done" }],
    });
  });
  it("unwraps MCP text and nested data instead of printing JSON or binary payloads", () => {
    const presentation = presentSessionTool(
      tool("mcp", {
        server: "issues",
        tool: "get_issue",
        arguments: { issue_id: "A-1" },
      }),
      result({
        content: [
          { type: "text", text: '{"title":"Retry safety","status":"done"}' },
          { type: "image", mimeType: "image/png", data: "secret-base64" },
        ],
        structuredContent: { data: { owner: "Payments" } },
      }),
    );
    expect(presentation).toMatchObject({
      summary: "Get issue",
      meta: "issues",
    });
    const view = JSON.stringify(presentation);
    expect(view).toContain("Retry safety");
    expect(view).toContain("Payments");
    expect(view).toContain("image/png");
    expect(view).not.toContain("secret-base64");
    expect(view).not.toContain('\\"title\\"');
  });
  it("prefers structured MCP data over duplicate JSON text while retaining prose", () => {
    const presentation = presentSessionTool(
      tool("mcp", { server: "issues", tool: "get_issue" }),
      result({
        content: [
          { type: "text", text: '{"title":"Retry safety"}' },
          { type: "text", text: "Fetched the issue." },
        ],
        structuredContent: { issue: { title: "Retry safety" } },
      }),
    );
    expect(
      JSON.stringify(presentation.blocks).match(/Retry safety/g),
    ).toHaveLength(1);
    expect(JSON.stringify(presentation)).toContain("Fetched the issue.");
  });
  it("keeps useful new/unknown tool parameters and malformed input inspectable", () => {
    const unknown = presentSessionTool(
      tool("unknown", {
        environment: "staging",
        options: { dry_run: true },
        regions: ["eu", "us"],
      }),
      result({ healthy: true, checks: [{ name: "API", latency_ms: 42 }] }),
    );
    expect(JSON.stringify(unknown)).toContain("Dry run");
    expect(JSON.stringify(unknown)).toContain("API");
    const malformed = presentSessionTool(
      tool("unknown", '{"incomplete":'),
      result("plain output"),
    );
    expect(
      malformed.blocks.find((block) => block.kind === "text")?.text,
    ).toContain("could not be parsed");
    expect(malformed.blocks).toContainEqual({
      kind: "text",
      title: "Result",
      text: "plain output",
    });
  });
  it("bounds huge results and reports local and upstream truncation", () => {
    const presentation = presentSessionTool(
      tool("glob", { pattern: "**/*" }),
      result(Array.from({ length: 5000 }, (_, i) => `src/file-${i}.ts`)),
    );
    const paths = presentation.blocks.find((block) => block.kind === "list");
    expect(paths?.items).toHaveLength(40);
    expect(presentation.notice).toContain("shortened");
    const long = presentSessionTool(
      tool("read", { path: "huge.txt" }),
      result("x".repeat(50000)),
    );
    expect(JSON.stringify(long).length).toBeLessThan(18000);
    expect(long.notice).toContain("shortened");
    expect(
      presentSessionTool(tool("read", {}, { truncated: true })).notice,
    ).toContain("shortened");
  });
  it("gives every canonical family a semantic verb and keeps plans visible", () => {
    const families = [
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
    for (const kind of families) {
      const call = tool(kind, {});
      expect(sessionToolVerb(call, false)).toBeTruthy();
      expect(sessionToolVerb(call, true)).toBeTruthy();
      expect(sessionToolVerb(call, false, "failed")).toMatch(/^Failed to /);
      expect(sessionToolVerb(call, false, "unknown")).toMatch(/^Attempted to /);
      expect(() => presentSessionTool(call, result({}))).not.toThrow();
    }
    expect(sessionToolKind(tool("todo_write", {}))).toBe("tool");
    expect(sessionToolKind(tool("constructor", {}))).toBe("tool");
    expect(sessionToolVerb(tool("constructor", {}), false)).toBe("Used tool");
    expect(sessionToolVerb(tool("bash", {}), false)).toBe("Ran");
    expect(sessionToolVerb(tool("edit", {}), false, "failed")).toBe(
      "Failed to edit",
    );
    expect(sessionToolVerb(tool("edit", {}), false, "unknown")).toBe(
      "Attempted to edit",
    );
    expect(
      presentSessionTool(
        tool("bash", { command: "pnpm test" }),
        result("", { execution: { exitCode: 0, interrupted: true } }),
      ).meta,
    ).toBe("Interrupted");
  });
  it("keeps nested members of generic arrays and describes binary attachments", () => {
    const presentation = presentSessionTool(
      tool("unknown", {}),
      result([
        {
          task: { name: "Review retries" },
          result: { text: "Cancellation failed" },
        },
        { type: "image", data: "secret-base64", mimeType: "image/png" },
      ]),
    );
    const rendered = JSON.stringify(presentation);
    expect(rendered).toContain("Review retries");
    expect(rendered).toContain("Cancellation failed");
    expect(rendered).toContain("Image attachment");
    expect(rendered).toContain("image/png");
    expect(rendered).not.toContain("secret-base64");
    const deep = presentSessionTool(
      tool("unknown", {}),
      result([
        { task: { level1: { level2: { level3: { message: "deep" } } } } },
      ]),
    );
    expect(deep.notice).toContain("shortened");
  });
  it("retains useful siblings alongside web sources and agent states", () => {
    const web = presentSessionTool(
      tool("web_search", { query: "retry" }),
      result(
        {
          results: [{ title: "Cached guide" }],
          error: { message: "Search quota exhausted" },
          status: "partial",
          message: "Showing cached sources",
        },
        { error: true },
      ),
    );
    const renderedWeb = JSON.stringify(web);
    expect(renderedWeb).toContain("Cached guide");
    expect(renderedWeb).toContain("Search quota exhausted");
    expect(renderedWeb).toContain("Showing cached sources");
    expect(renderedWeb).toContain("partial");
    const agent = presentSessionTool(
      tool("agent_collaboration", {}),
      result(
        {
          agentsStates: { reviewer: { status: "failed" } },
          final: "Review incomplete",
          error: { message: "Agent disconnected" },
        },
        { error: true },
      ),
    );
    expect(JSON.stringify(agent)).toContain("Review incomplete");
    expect(JSON.stringify(agent)).toContain("Agent disconnected");
    expect(JSON.stringify(agent).match(/reviewer/g)).toHaveLength(1);
  });
  it("reserves result space so large proposed changes cannot obscure failures", () => {
    const crowded = presentSessionTool(
      tool("mcp", {}),
      result(
        {
          content: [{ type: "text", text: "x".repeat(16000) }],
          ...Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => [
              "field" + index,
              "z".repeat(1000),
            ]),
          ),
          error: { message: "The operation was rejected." },
        },
        { error: true },
      ),
    );
    expect(JSON.stringify(crowded)).toContain("The operation was rejected.");
    const changes = [
      { path: "one.ts", diff: "+x".repeat(5000) },
      { path: "two.ts", diff: "+y".repeat(5000) },
    ];
    const presentation = presentSessionTool(
      tool("file_changes", { changes }),
      result(
        { error: { message: "Patch rejected: workspace is read-only" } },
        { error: true },
      ),
    );
    expect(JSON.stringify(presentation)).toContain(
      "Patch rejected: workspace is read-only",
    );
    expect(presentation.notice).toContain("shortened");
    const web = presentSessionTool(
      tool("web_search", { query: "retry" }),
      result(
        {
          results: Array.from({ length: 40 }, () => ({
            title: "Source".repeat(200),
          })),
          error: { message: "Only cached results available" },
        },
        { error: true },
      ),
    );
    expect(JSON.stringify(web)).toContain("Only cached results available");
  });
  it("parses nested shell output instead of treating non-string output as empty", () => {
    const presentation = presentSessionTool(
      tool("bash", { command: "inspect" }),
      result(
        {
          output: {
            summary: "Service unavailable",
            details: { retry_after: 30 },
          },
          stderr: { message: "Connection refused" },
          exit_code: 1,
        },
        { error: true },
      ),
    );
    expect(JSON.stringify(presentation)).toContain("Service unavailable");
    expect(JSON.stringify(presentation)).toContain("Connection refused");
    expect(JSON.stringify(presentation)).toContain("Retry after");
  });
  it("labels end lines accurately and distinguishes proposed changes from receipts", () => {
    const read = presentSessionTool(
      tool("read", { path: "a.ts", start_line: 4, end_line: 8 }),
    );
    expect(read.blocks).toContainEqual({
      kind: "fields",
      title: undefined,
      fields: [
        { label: "File", value: "a.ts" },
        { label: "Start line", value: "4" },
        { label: "End line", value: "8" },
      ],
    });
    const call = tool("edit", {
      path: "a.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(
      presentSessionTool(call).blocks.find((block) => block.kind === "diff")
        ?.title,
    ).toBe("Proposed replacement");
    expect(
      presentSessionTool(
        call,
        result("Permission denied", { error: true }),
      ).blocks.find((block) => block.kind === "diff")?.title,
    ).toBe("Proposed replacement");
    expect(
      presentSessionTool(call, result("Updated")).blocks.find(
        (block) => block.kind === "diff",
      )?.title,
    ).toBe("Replacement");
    const write = presentSessionTool(
      tool("write", { path: "a.ts", content: "a" }),
      result("Denied", { error: true }),
    );
    expect(write.blocks.find((block) => block.kind === "code")?.title).toBe(
      "Proposed content",
    );
    const files = presentSessionTool(
      tool("file_changes", {
        changes: [
          { path: "old.ts", kind: { type: "update", move_path: "new.ts" } },
          { path: "created.ts", kind: { type: "add" } },
        ],
      }),
    );
    expect(files.blocks.find((block) => block.kind === "list")).toMatchObject({
      title: "Proposed files",
      items: [
        { label: "old.ts", detail: "Update → new.ts" },
        { label: "created.ts", detail: "Add" },
      ],
    });
  });
});
