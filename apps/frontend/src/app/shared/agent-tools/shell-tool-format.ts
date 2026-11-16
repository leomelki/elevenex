import Anser from 'anser';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { contentToString, extractToolError, isHardError } from './agent-tool-format';

export type ShellState = 'running' | 'done' | 'error' | 'denied' | 'incomplete' | 'interrupted';

export interface ShellToolView {
  readonly command: string;
  readonly description: string;
  readonly directory: string;
  /** Plain captured text (ANSI removed, carriage-return overwrites applied) for copy and preview. */
  readonly output: string;
  /** Styled terminal lines parsed from the captured ANSI output. */
  readonly lines: readonly TerminalLine[];
  readonly preview: string;
  readonly lineCount: number;
  readonly state: ShellState;
  readonly status: string;
  readonly duration: string;
  readonly emptyMessage: string;
}

/** Normalize provider receipts once per content change, independently of the live timer. */
export function shellToolView(
  call: AgentTranscriptItem,
  result: AgentTranscriptItem | null,
  live: boolean,
): ShellToolView {
  const input = record(call.toolInput);
  const receipt = record(result?.providerToolResult);
  const command = string(input['command']) || string(input['cmd']);
  const denied =
    call.interaction?.decision === 'denied' || call.interaction?.decision === 'declined';
  const exitCode = integer(receipt['exitCode'] ?? receipt['exit_code']);
  const interrupted = receipt['interrupted'] === true;
  let state: ShellState = 'done';
  if (denied) state = 'denied';
  else if (!result) state = live ? 'running' : 'incomplete';
  else if (interrupted) state = 'interrupted';
  else if (result.isError || (exitCode !== null && exitCode !== 0)) state = 'error';
  const statusLabels: Record<ShellState, string> = {
    denied: call.interaction?.decisionLabel || 'Denied',
    incomplete: 'No result recorded',
    interrupted: 'Interrupted',
    running: 'Running',
    error: exitCode !== null && exitCode !== 0 ? `Exit ${exitCode}` : 'Failed',
    done: exitCode !== null ? `Exit ${exitCode}` : 'Completed',
  };
  const emptyMessages: Record<ShellState, string> = {
    running: 'Waiting for output…',
    denied: 'Command was not run.',
    incomplete: 'No result was recorded for this command.',
    interrupted: 'Command was interrupted before returning output.',
    error: 'Command failed without output.',
    done: 'Command completed without output.',
  };
  const raw = contentToString(result?.content);
  const fallback = [string(receipt['stdout']), string(receipt['stderr'])]
    .filter(Boolean)
    .join('\n');
  // Output is always rendered as text nodes. ANSI sequences only become bounded style values.
  const lines = parseTerminalOutput(isHardError(result) ? extractToolError(raw) : raw || fallback);
  const output = terminalPlainText(lines);
  const lineCount = lines.length;
  const preview = output.slice(-2000).trimEnd().split('\n').at(-1)?.trim().slice(0, 240) ?? '';
  const durationMs = finiteNumber(receipt['durationMs'] ?? receipt['duration_ms']);
  return {
    command,
    description: string(input['description']).trim(),
    directory: string(input['workdir']) || string(input['cwd']),
    output,
    lines,
    preview,
    lineCount,
    state,
    status: statusLabels[state],
    duration: durationMs !== null && durationMs >= 0 ? formatShellDuration(durationMs / 1000) : '',
    emptyMessage: emptyMessages[state],
  };
}

export function formatShellDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safe < 60) return `${safe}s`;
  return `${Math.floor(safe / 60)}m ${safe % 60}s`;
}

/** Render a generous tail by default; "show all" stays bounded so the DOM remains responsive. */
export const TERMINAL_TAIL_LINES = 2000;
export const TERMINAL_MAX_LINES = 20_000;
export function terminalWindow(lines: readonly TerminalLine[], showAll: boolean) {
  const limit = showAll ? TERMINAL_MAX_LINES : TERMINAL_TAIL_LINES;
  const start = Math.max(0, lines.length - limit);
  return { lines: start ? lines.slice(start) : lines, hidden: start };
}

export interface TerminalSpan {
  readonly text: string;
  readonly fg: string | null;
  readonly bg: string | null;
  /** Space-separated decoration classes (`cw-term--bold`, …), empty when unstyled. */
  readonly decoration: string;
}
export type TerminalLine = readonly TerminalSpan[];

/** Parse only the tail of pathological output; providers already cap what they capture. */
const MAX_PARSED_CHARACTERS = 500_000;
const NAMED_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;
const DECORATIONS = new Set(['bold', 'dim', 'italic', 'underline', 'strikethrough', 'hidden']);

/**
 * Convert captured terminal output into styled lines the way a terminal would show it:
 * SGR colors and decorations are kept, a bare carriage return overwrites the current line,
 * and every other control sequence (cursor moves, OSC titles/links, bells) is dropped.
 */
export function parseTerminalOutput(raw: string): TerminalLine[] {
  const source = (raw.length > MAX_PARSED_CHARACTERS ? raw.slice(-MAX_PARSED_CHARACTERS) : raw)
    // OSC sequences (window titles, hyperlinks) terminate with BEL or ST.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\r\n/g, '\n');
  const lines: TerminalSpan[][] = [[]];
  // A carriage return only overwrites once new text arrives, like a real cursor return.
  let returned = false;
  for (const entry of Anser.ansiToJson(source, { use_classes: true, remove_empty: true })) {
    const fg = terminalColor(entry.fg, entry.fg_truecolor);
    const bg = terminalColor(entry.bg, entry.bg_truecolor);
    const decoration = (entry.decorations ?? [])
      .filter((name) => DECORATIONS.has(name))
      .map((name) => `cw-term--${name}`)
      .join(' ');
    const parts = entry.content.split(/(\n|\r)/);
    for (const part of parts) {
      if (part === '\n') {
        lines.push([]);
        returned = false;
      } else if (part === '\r') returned = true;
      else {
        // Drop leftover C0 controls (bell, backspace, stray escapes) but keep tabs.
        const text = part.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
        if (!text) continue;
        if (returned) lines[lines.length - 1] = [];
        returned = false;
        const line = lines[lines.length - 1];
        const last = line.at(-1);
        if (last && last.fg === fg && last.bg === bg && last.decoration === decoration)
          line[line.length - 1] = { ...last, text: last.text + text };
        else line.push({ text, fg, bg, decoration });
      }
    }
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines.length === 1 && lines[0].length === 0 ? [] : lines;
}

export function terminalPlainText(lines: readonly TerminalLine[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n');
}

/** Map Anser color classes onto the shared terminal palette CSS variables. */
function terminalColor(name: string | null, truecolor: string | null): string | null {
  if (!name) return null;
  if (name === 'ansi-truecolor')
    return truecolor && /^\d{1,3}, \d{1,3}, \d{1,3}$/.test(truecolor) ? `rgb(${truecolor})` : null;
  const named = /^ansi-(bright-)?(black|red|green|yellow|blue|magenta|cyan|white)$/.exec(name);
  if (named) return `var(--terminal-${named[1] ? 'bright-' : ''}${named[2]})`;
  const palette = /^ansi-palette-(\d{1,3})$/.exec(name);
  if (!palette) return null;
  const index = Number(palette[1]);
  if (index < 16) return `var(--terminal-${index >= 8 ? 'bright-' : ''}${NAMED_COLORS[index % 8]})`;
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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
