import { describe, expect, it } from "vitest";
import {
  parseInline,
  parseMarkdown,
  safeMarkdownTarget,
  safeMediaSource,
} from "./markdown-parser";

describe("safe Markdown rendering model", () => {
  it("retains HTML as inert text and rejects active link schemes", () => {
    const source =
      "<img src=x onerror=alert(1)> [bad](javascript:alert) [bad](data:text/html)";
    expect(parseInline(source).every((node) => node.kind === "text")).toBe(
      true,
    );
    expect(safeMarkdownTarget("https://example.com/docs")).toBe("web");
    expect(safeMarkdownTarget("src/payments/retry.ts")).toBe("file");
    for (const target of [
      "javascript:alert(1)",
      "data:text/html,test",
      "//example.com",
      "https://user:password@example.com",
      "\u0000file",
    ])
      expect(safeMarkdownTarget(target)).toBeNull();
  });
  it("only resolves media compatible with the confined asset policy", () => {
    expect(safeMediaSource("/assets/report.png")).toBe("/assets/report.png");
    expect(safeMediaSource("app://elevenex/assets/report.png")).toBe(
      "app://elevenex/assets/report.png",
    );
    expect(safeMediaSource("data:image/png;base64,aGVsbG8=")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
    for (const source of [
      "https://tracker.example/pixel",
      "//example.com",
      "/\n/example.com",
      "/\\example.com",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "javascript:alert(1)",
    ])
      expect(safeMediaSource(source)).toBe("");
  });
  it("parses nested lists, readonly tasks, callouts and tables", () => {
    const blocks = parseMarkdown(
      "> [!TIP]\n> Keep cancellation.\n\n1. Read\n   - Nested\n2. Apply\n\n- [x] Tested\n\n| Input | Delay |\n| --- | --- |\n| bad | fallback |",
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "quote",
      "list",
      "list",
      "table",
    ]);
    const list = blocks[1];
    expect(
      list?.kind === "list" &&
        list.items[0]?.blocks.some((block) => block.kind === "list"),
    ).toBe(true);
    const task = blocks[2];
    expect(task?.kind === "list" && task.items[0]?.checked).toBe(true);
  });
  it("withholds incomplete streamed embeds and leaves fenced code readable", () => {
    expect(parseMarkdown("![Report](report.png)", true)).toEqual([]);
    expect(parseMarkdown("![Report](report.png)\n", true)[0]?.kind).toBe(
      "embed",
    );
    expect(parseMarkdown("```ts\nconst value = 1;", true)).toEqual([
      {
        kind: "code",
        language: "ts",
        text: "const value = 1;",
        complete: false,
      },
    ]);
  });
});

describe("adjacent media", () => {
  it("groups complete images while withholding an incomplete streamed line", () => {
    expect(
      parseMarkdown("![Before](before.png)\n![After](after.png)\n", true),
    ).toEqual([
      {
        kind: "embeds",
        items: [
          { caption: "Before", path: "before.png" },
          { caption: "After", path: "after.png" },
        ],
      },
    ]);
    expect(
      parseMarkdown("![Before](before.png)\n![After](after.png)", true),
    ).toEqual([{ kind: "embed", caption: "Before", path: "before.png" }]);
  });
});
