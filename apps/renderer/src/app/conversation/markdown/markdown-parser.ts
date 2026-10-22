/** Markdown is rendered as Angular text nodes, never interpreted as HTML. */
export type MarkdownInline =
  | { readonly kind: "text" | "code"; readonly text: string }
  | {
      readonly kind: "strong" | "em" | "strike";
      readonly children: readonly MarkdownInline[];
    }
  | {
      readonly kind: "link";
      readonly target: string;
      readonly children: readonly MarkdownInline[];
      readonly external: boolean;
    };
export interface MarkdownEmbed {
  readonly caption: string;
  readonly path: string;
}
export type MarkdownBlock =
  | { readonly kind: "paragraph"; readonly content: readonly MarkdownInline[] }
  | {
      readonly kind: "heading";
      readonly level: number;
      readonly content: readonly MarkdownInline[];
    }
  | {
      readonly kind: "code";
      readonly language: string;
      readonly text: string;
      readonly complete: boolean;
    }
  | {
      readonly kind: "quote";
      readonly tone: string;
      readonly blocks: readonly MarkdownBlock[];
    }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly {
        readonly checked: boolean | null;
        readonly blocks: readonly MarkdownBlock[];
      }[];
    }
  | {
      readonly kind: "table";
      readonly headers: readonly (readonly MarkdownInline[])[];
      readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
    }
  | { readonly kind: "embed"; readonly caption: string; readonly path: string }
  | { readonly kind: "embeds"; readonly items: readonly MarkdownEmbed[] }
  | { readonly kind: "rule" };
export type MarkdownAsset =
  | {
      readonly kind: "image";
      readonly src: string;
      readonly w: number;
      readonly h: number;
    }
  | {
      readonly kind: "video";
      readonly src?: string;
      readonly dur?: number;
      readonly poster?: string;
      readonly w: number;
      readonly h: number;
      readonly marks?: readonly {
        readonly t: number;
        readonly label: string;
      }[];
    }
  | {
      readonly kind: "page";
      readonly title?: string;
      readonly srcdoc?: string;
      readonly url?: string;
    };
export type MarkdownAssetResolver = (
  path: string,
) => MarkdownAsset | null | undefined;
export function safeMarkdownTarget(target: string): "web" | "file" | null {
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      return url.username || url.password ? null : "web";
    } catch {
      return null;
    }
  }
  // A link is an intent to open a task file, not a browser navigation.
  return target &&
    !/^[a-z][a-z\d+.-]*:/i.test(target) &&
    !target.startsWith("//") &&
    !Array.from(target).some((character) => character.charCodeAt(0) < 32)
    ? "file"
    : null;
}
export function parseInline(
  source: string,
  depth = 0,
): readonly MarkdownInline[] {
  if (depth > 12) return [{ kind: "text", text: source }];
  const result: MarkdownInline[] = [];
  const pattern =
    /(`+)([\s\S]*?)\1|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset)
      result.push({ kind: "text", text: source.slice(offset, match.index) });
    if (match[1]) result.push({ kind: "code", text: match[2] ?? "" });
    else if (match[3]) {
      const target = match[4] ?? "";
      const safe = safeMarkdownTarget(target);
      result.push(
        safe
          ? {
              kind: "link",
              target,
              children: parseInline(match[3], depth + 1),
              external: safe === "web",
            }
          : { kind: "text", text: match[0] },
      );
    } else {
      const content =
        match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9] ?? "";
      result.push({
        kind: match[5] || match[6] ? "strong" : match[7] ? "strike" : "em",
        children: parseInline(content, depth + 1),
      });
    }
    offset = match.index + match[0].length;
  }
  if (offset < source.length)
    result.push({ kind: "text", text: source.slice(offset) });
  return result;
}
const listPattern = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
export function parseMarkdown(
  source: string,
  streaming = false,
  depth = 0,
): readonly MarkdownBlock[] {
  if (depth > 12) return [{ kind: "paragraph", content: parseInline(source) }];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const result: MarkdownBlock[] = [];
  let index = 0;
  const beginsBlock = (line: string): boolean =>
    /^(?:\s*```|\s*~~~|#{1,6}\s|>\s?|\s*[-+*]\s|\s*\d+[.)]\s|\s*(?:---+|\*\*\*+)\s*$)/.test(
      line,
    );
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})([\w-]*)\s*$/.exec(line);
    if (fence) {
      const text: string[] = [];
      index++;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith(fence[1] ?? "```")
      )
        text.push(lines[index++] ?? "");
      const complete = index < lines.length;
      if (complete) index++;
      result.push({
        kind: "code",
        language: fence[2] ?? "",
        text: text.join("\n"),
        complete,
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      result.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        content: parseInline(heading[2] ?? ""),
      });
      index++;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      result.push({ kind: "rule" });
      index++;
      continue;
    }
    const embedPattern = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
    const embed = embedPattern.exec(line);
    if (embed) {
      const embeds: MarkdownEmbed[] = [];
      while (index < lines.length) {
        const next = embedPattern.exec(lines[index] ?? "");
        if (!next) break;
        if (!(streaming && index === lines.length - 1))
          embeds.push({ caption: next[1] ?? "", path: next[2] ?? "" });
        index++;
      }
      if (embeds.length > 1) result.push({ kind: "embeds", items: embeds });
      else if (embeds[0]) result.push({ kind: "embed", ...embeds[0] });
      continue;
    }
    if (/^>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>/.test(lines[index] ?? ""))
        quote.push((lines[index++] ?? "").replace(/^>\s?/, ""));
      const callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(
        quote[0] ?? "",
      );
      if (callout) quote[0] = (quote[0] ?? "").slice(callout[0].length);
      result.push({
        kind: "quote",
        tone: callout?.[1]?.toLowerCase() ?? "",
        blocks: parseMarkdown(quote.join("\n"), streaming, depth + 1),
      });
      continue;
    }
    const list = listPattern.exec(line);
    if (list) {
      const indent = list[1]?.length ?? 0;
      const ordered = /^\d/.test(list[2] ?? "");
      const items: {
        checked: boolean | null;
        blocks: readonly MarkdownBlock[];
      }[] = [];
      while (index < lines.length) {
        const item = listPattern.exec(lines[index] ?? "");
        if (
          !item ||
          (item[1]?.length ?? 0) !== indent ||
          /^\d/.test(item[2] ?? "") !== ordered
        )
          break;
        const itemLines = [item[3] ?? ""];
        index++;
        while (index < lines.length) {
          const next = lines[index] ?? "";
          if (!next.trim()) {
            if ((lines[index + 1]?.search(/\S/) ?? 0) > indent) {
              itemLines.push("");
              index++;
              continue;
            }
            break;
          }
          if (next.search(/\S/) <= indent) break;
          itemLines.push(next.slice(Math.min(next.search(/\S/), indent + 2)));
          index++;
        }
        const task = /^\[([ xX])\]\s+/.exec(itemLines[0] ?? "");
        if (task) itemLines[0] = (itemLines[0] ?? "").slice(task[0].length);
        items.push({
          checked: task ? task[1]?.toLowerCase() === "x" : null,
          blocks: parseMarkdown(itemLines.join("\n"), streaming, depth + 1),
        });
      }
      result.push({
        kind: "list",
        ordered,
        start: ordered ? Number.parseInt(list[2] ?? "1", 10) : 1,
        items,
      });
      continue;
    }
    if (
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
        lines[index + 1] ?? "",
      )
    ) {
      const headers = tableCells(line).map((parseCell) =>
        parseInline(parseCell),
      );
      index += 2;
      const rows: (readonly (readonly MarkdownInline[])[])[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").includes("|") &&
        (lines[index] ?? "").trim()
      )
        rows.push(
          tableCells(lines[index++] ?? "").map((cell) => parseInline(cell)),
        );
      result.push({ kind: "table", headers, rows });
      continue;
    }
    const paragraph = [line];
    index++;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !beginsBlock(lines[index] ?? "") &&
      !/^!\[/.test(lines[index] ?? "")
    ) {
      if (
        (lines[index] ?? "").includes("|") &&
        /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")
      )
        break;
      paragraph.push(lines[index++] ?? "");
    }
    result.push({
      kind: "paragraph",
      content: parseInline(paragraph.join("\n")),
    });
  }
  return result;
}
/** Matches the desktop's restrictive media policy. External files need an app asset adapter. */
export function safeMediaSource(source: string): string {
  if (
    Array.from(source).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return "";
  if (
    /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z\d+/=\s]+$/i.test(
      source,
    )
  )
    return source;
  if (
    source.startsWith("/") &&
    !source.startsWith("//") &&
    !source.includes("\\")
  )
    return source;
  if (/^app:\/\//i.test(source)) return source;
  return "";
}
