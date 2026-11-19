import Anser from "anser";

export interface TerminalSpan {
  readonly text: string;
  readonly fg: string | null;
  readonly bg: string | null;
  /** Space-separated decoration classes (`term--bold`, …), empty when unstyled. */
  readonly decoration: string;
}
export type TerminalLine = readonly TerminalSpan[];

/** Parse only the tail of pathological output; providers already cap what they capture. */
const MAX_PARSED_CHARACTERS = 100_000;
const NAMED_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;
const COLOR_TOKENS: Record<string, string> = {
  black: "ink",
  red: "danger",
  green: "diff-add",
  yellow: "attention",
  blue: "code-function",
  magenta: "code-keyword",
  cyan: "accent",
  white: "ink",
};
const DECORATIONS = new Set([
  "bold",
  "dim",
  "italic",
  "underline",
  "strikethrough",
  "hidden",
]);

/**
 * Convert captured terminal output into styled lines the way a terminal would show it:
 * SGR colors and decorations are kept, a bare carriage return overwrites from the start of the line,
 * and every other control sequence (cursor moves, OSC titles/links, bells) is dropped.
 */
export function parseTerminalOutput(raw: string): TerminalLine[] {
  const source = (
    raw.length > MAX_PARSED_CHARACTERS ? raw.slice(-MAX_PARSED_CHARACTERS) : raw
  )
    // OSC sequences (window titles, hyperlinks) terminate with BEL or ST.
    // eslint-disable-next-line no-control-regex -- Strip terminal OSC control bytes, never interpret their payload.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\r\n/g, "\n");
  const lines: TerminalSpan[][] = [[]];
  // A carriage return only overwrites once new text arrives, like a real cursor return.
  let cursor: number | null = null;
  for (const entry of Anser.ansiToJson(source, {
    use_classes: true,
    remove_empty: true,
  })) {
    const fg = terminalColor(entry.fg, entry.fg_truecolor);
    const bg = terminalColor(entry.bg, entry.bg_truecolor, true);
    const decoration = (entry.decorations ?? [])
      .filter((name) => DECORATIONS.has(name))
      .map((name) => `term--${name}`)
      .join(" ");
    const parts = entry.content.split(/(\n|\r)/);
    for (const part of parts) {
      if (part === "\n") {
        lines.push([]);
        cursor = null;
      } else if (part === "\r") cursor = 0;
      else {
        // Drop leftover C0 controls (bell, backspace, stray escapes) but keep tabs.
        // eslint-disable-next-line no-control-regex -- C0 control bytes are intentionally removed from captured text.
        const text = part.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
        if (!text) continue;
        if (cursor !== null) {
          const line = lines[lines.length - 1]!;
          const before: TerminalSpan[] = [],
            after: TerminalSpan[] = [];
          let offset = 0;
          for (const span of line) {
            if (offset < cursor) {
              const prefix = span.text.slice(0, cursor - offset);
              if (prefix) before.push({ ...span, text: prefix });
            }
            const suffix = span.text.slice(
              Math.max(0, cursor + text.length - offset),
            );
            if (offset + span.text.length > cursor + text.length && suffix)
              after.push({ ...span, text: suffix });
            offset += span.text.length;
          }
          lines[lines.length - 1] = [
            ...before,
            { text, fg, bg, decoration },
            ...after,
          ];
          cursor += text.length;
          continue;
        }
        const line = lines[lines.length - 1]!;
        const last = line.at(-1);
        if (
          last &&
          last.fg === fg &&
          last.bg === bg &&
          last.decoration === decoration
        )
          line[line.length - 1] = { ...last, text: last.text + text };
        else line.push({ text, fg, bg, decoration });
      }
    }
  }
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines.length === 1 && lines[0]!.length === 0 ? [] : lines;
}

export function terminalPlainText(lines: readonly TerminalLine[]): string {
  return lines.map((line) => line.map((span) => span.text).join("")).join("\n");
}

/** Standard ANSI colors follow the desktop theme; explicit RGB/256 colors stay literal. */
function terminalColor(
  name: string | null,
  truecolor: string | null,
  background = false,
): string | null {
  if (!name) return null;
  if (name === "ansi-truecolor")
    return truecolor && /^\d{1,3}, \d{1,3}, \d{1,3}$/.test(truecolor)
      ? `rgb(${truecolor})`
      : null;
  const named =
    /^ansi-(bright-)?(black|red|green|yellow|blue|magenta|cyan|white)$/.exec(
      name,
    );

  if (named && background) {
    const colors: Record<string, string> = {
      black: "surface-sunken",
      white: "surface-raised",
      red: "danger-soft",
      green: "diff-add-soft",
      yellow: "attention-soft",
      blue: "review-soft",
      magenta: "review-soft",
      cyan: "accent-soft",
    };
    return `var(--${colors[named[2]!]})`;
  }
  if (named)
    return `var(--${named[1] && named[2] === "black" ? "ink-muted" : COLOR_TOKENS[named[2]!]})`;
  const palette = /^ansi-palette-(\d{1,3})$/.exec(name);
  if (!palette) return null;
  const index = Number(palette[1]);
  if (index < 16)
    return terminalColor(
      `ansi-${index >= 8 ? "bright-" : ""}${NAMED_COLORS[index % 8]}`,
      null,
      background,
    );
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const offset = index - 16;
    return `rgb(${steps[Math.floor(offset / 36)]}, ${steps[Math.floor(offset / 6) % 6]}, ${steps[offset % 6]})`;
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return null;
}

/** Keep the initial DOM small and allow explicit expansion without an unbounded log view. */
export const SHELL_TAIL_LINES = 80;
export const SHELL_MAX_LINES = 1000;
export function shellOutputWindow(
  lines: readonly TerminalLine[],
  expanded: boolean,
) {
  const start = Math.max(
    0,
    lines.length - (expanded ? SHELL_MAX_LINES : SHELL_TAIL_LINES),
  );
  return { lines: start ? lines.slice(start) : lines, hidden: start };
}
