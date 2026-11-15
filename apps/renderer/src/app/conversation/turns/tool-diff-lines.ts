import { codeTokens, type CodeToken } from "../markdown/code-tokens";
import type { ToolBlock } from "../tool-presentation";

export interface ToolDiffLine {
  readonly text: string;
  readonly tone: "added" | "removed" | "context" | "";
  readonly metadata: boolean;
  readonly sign: string;
  readonly tokens: readonly CodeToken[];
}

/** A terminal newline terminates a line; it does not add a phantom diff row. */
function evidenceLines(text: string): readonly string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Separate patch markers from source without altering the source's whitespace. */
export function toolDiffLines(
  block: Extract<ToolBlock, { kind: "diff" | "patch" }>,
): readonly ToolDiffLine[] {
  const fileLanguage = (path: string): string =>
    /\.([cm]?[jt]sx?)$/i.exec(path)?.[1] ?? "";
  let language = fileLanguage(block.title ?? "");
  const line = (
    text: string,
    tone: ToolDiffLine["tone"],
    metadata = false,
  ): ToolDiffLine => ({
    text,
    tone,
    metadata,
    sign: tone === "added" ? "+" : tone === "removed" ? "−" : " ",
    tokens: codeTokens(text || " ", metadata ? "" : language),
  });
  if (block.kind === "diff")
    return [
      ...evidenceLines(block.before).map((text) => line(text, "removed")),
      ...evidenceLines(block.after).map((text) => line(text, "added")),
    ];

  let inHunk = false;
  let oldRemaining: number | undefined;
  let newRemaining: number | undefined;
  return evidenceLines(block.text).map((text) => {
    if (text.startsWith("@@")) {
      const range = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
      oldRemaining = range ? Number(range[1] ?? 1) : undefined;
      newRemaining = range ? Number(range[2] ?? 1) : undefined;
      inHunk = !range || oldRemaining !== 0 || newRemaining !== 0;
      return line(text, "context", true);
    }
    if (text.startsWith("***") || text.startsWith("diff --git ")) {
      const path = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(text)?.[1];
      if (path) language = fileLanguage(path);
      inHunk = text.startsWith("*** Add File:");
      oldRemaining = newRemaining = undefined;
      return line(text, "context", true);
    }
    const header =
      !inHunk && (text.startsWith("+++ ") || text.startsWith("--- "));
    if (header && text.slice(4) !== "/dev/null")
      language = fileLanguage(text.slice(4));
    if (
      header ||
      (!inHunk && /^(?:index |new file mode |deleted file mode |rename (?:from|to) |similarity index )/.test(text))
    )
      return line(text, "context", true);
    const tone = text.startsWith("+")
      ? "added"
      : text.startsWith("-")
        ? "removed"
        : "";
    const source =
      tone !== "" || (inHunk && text.startsWith(" ")) ? text.slice(1) : text;
    if (inHunk && oldRemaining !== undefined && newRemaining !== undefined) {
      if (text.startsWith("-") || text.startsWith(" ")) oldRemaining--;
      if (text.startsWith("+") || text.startsWith(" ")) newRemaining--;
      if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
    }
    return line(source, tone);
  });
}
