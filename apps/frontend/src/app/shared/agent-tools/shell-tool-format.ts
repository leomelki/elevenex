import Anser from 'anser';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { contentToString, extractToolError, isHardError } from './agent-tool-format';

export type ShellState = 'running' | 'done' | 'error' | 'denied' | 'incomplete' | 'interrupted';

export interface ShellToolView {
  readonly command: string;
  readonly description: string;
  readonly directory: string;
  readonly output: string;
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
  // Output is always rendered as text. ANSI sequences must not become HTML or links.
  const output = Anser.ansiToText(
    isHardError(result) ? extractToolError(raw) : raw || fallback,
  ).replace(/\r\n?/g, '\n');
  const lineCount = outputLineCount(output);
  const preview = output.slice(-2000).trimEnd().split('\n').at(-1)?.trim().slice(0, 240) ?? '';
  const durationMs = finiteNumber(receipt['durationMs'] ?? receipt['duration_ms']);
  return {
    command,
    description: string(input['description']).trim(),
    directory: string(input['workdir']) || string(input['cwd']),
    output,
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

export function outputLineCount(text: string): number {
  if (!text) return 0;
  let lines = text.endsWith('\n') ? 0 : 1;
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lines++;
  return lines;
}

/** Keep the useful tail bounded even for a single huge line. Copy retains all captured output. */
export function shellOutputWindow(text: string, expanded: boolean) {
  const maxCharacters = expanded ? 100_000 : 24_000;
  const maxLines = expanded ? 1000 : 200;
  let start = Math.max(0, text.length - maxCharacters);
  let lines = 0;
  for (let index = text.length - (text.endsWith('\n') ? 2 : 1); index >= start; index--) {
    if (text[index] === '\n' && ++lines === maxLines) {
      start = index + 1;
      break;
    }
  }
  return { text: text.slice(start), truncated: start > 0 };
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
