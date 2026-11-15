import { describe, expect, it } from "vitest";
import { toolDiffLines } from "./tool-diff-lines";

describe("tool diff evidence", () => {
  it("separates patch markers from indented source and preserves literal prefix characters", () => {
    const lines = toolDiffLines({
      kind: "patch",
      text: "--- a/literal.ts\r\n+++ b/literal.ts\r\n@@ -1,2 +1,2 @@\r\n   keep spaces  \r\n---old\r\n+++new\r\n",
    });
    expect(lines.filter(line => line.metadata).map(line => line.text)).toEqual([
      "--- a/literal.ts", "+++ b/literal.ts", "@@ -1,2 +1,2 @@",
    ]);
    expect(lines.filter(line => !line.metadata).map(line => [line.sign, line.text])).toEqual([
      [" ", "  keep spaces  "], ["−", "--old"], ["+", "++new"],
    ]);
  });

  it("recognizes file headers after a completed hunk and changes language per file", () => {
    const lines = toolDiffLines({
      kind: "patch",
      text: "+++ b/one.ts\n@@ -0,0 +1 @@\n+const one = 1;\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1 @@\n+const two = 2;\n",
    });
    expect(lines.filter(line => line.tone === "added")).toHaveLength(2);
    expect(lines.find(line => line.text === "--- /dev/null")?.metadata).toBe(true);
    expect(lines.find(line => line.text === "const one = 1;")?.tokens).toContainEqual({ kind: "keyword", text: "const" });
    expect(lines.find(line => line.text === "const two = 2;")?.tokens).toEqual([{ kind: "plain", text: "const two = 2;" }]);
  });

  it("handles apply_patch envelopes without treating headers as source", () => {
    const lines = toolDiffLines({
      kind: "patch",
      title: "Proposed patch",
      text: "*** Begin Patch\n*** Add File: new.ts\n+export const answer = 42;\n*** End Patch\n",
    });
    expect(lines.filter(line => line.metadata)).toHaveLength(3);
    expect(lines[2]?.tokens).toContainEqual({ kind: "keyword", text: "export" });
    expect(lines[2]?.text).toBe("export const answer = 42;");
  });

  it("retains the deleted file's language when its destination is /dev/null", () => {
    const lines = toolDiffLines({
      kind: "patch",
      text: "--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const removed = 1;\n",
    });
    expect(lines.find(line => line.tone === "removed")?.tokens).toContainEqual({ kind: "keyword", text: "export" });
  });

  it("keeps literal contents, intentional blank lines and inert markup intact", () => {
    const lines = toolDiffLines({
      kind: "diff",
      title: "literal.ts",
      before: "",
      after: "++counter\r\n\r\n<script>alert(1)</script>\r\n",
    });
    expect(lines.map(line => line.text)).toEqual(["++counter", "", "<script>alert(1)</script>"]);
    for (const line of lines)
      expect(line.tokens.map(token => token.text).join("")).toBe(line.text || " ");
    expect(toolDiffLines({ kind: "diff", before: "", after: "" })).toEqual([]);
  });
});
