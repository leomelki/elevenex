import { promises as fs } from 'node:fs';
import { ToolError, type ToolContext } from '../../tool-registry/tool.types.js';
import { resolveWorktreeScope } from '../observe/_resolve-scope.js';

/**
 * Structural view of an `actions` row — only the columns the tools surface.
 * Kept local so a tool file never depends on the drizzle schema types.
 */
export interface ActionRow {
  id: number;
  worktreePath: string;
  name: string;
  command: string;
  status: string;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastExitCode: number | null;
  currentOutput: string;
  lastOutput: string;
}

/** Commands are one-liners in practice; cap the pathological paste. */
const MAX_COMMAND_CHARS = 400;
/** Ceiling on returned output regardless of the requested line count. */
const MAX_OUTPUT_CHARS = 8_000;
/** Terminal-escape sequences the pty embeds — pure noise (and tokens) for a model. */
// eslint-disable-next-line no-control-regex -- matching the escape byte is the point
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Resolve which worktree the action belongs to. Same contract as the observe
 * tools: a `sessionId` (preferred — its worktree is authoritative) or an
 * explicit `worktreePath`.
 */
export async function resolveActionScope(
  ctx: ToolContext,
  args: { sessionId?: number; worktreePath?: string },
): Promise<{ worktreePath: string; sessionId: number | null }> {
  const scope = await resolveWorktreeScope(ctx, args);
  return { worktreePath: scope.worktreePath, sessionId: scope.sessionId };
}

/** Load an action by id, mapping "not found" to a self-correcting ToolError. */
export async function resolveAction(
  ctx: ToolContext,
  actionId: number,
): Promise<ActionRow> {
  const action = await ctx.services.actions.findOne(actionId).catch(() => null);
  if (!action) {
    throw new ToolError({
      code: 'action_not_found',
      message: `No action with id ${actionId}.`,
      remediation: 'List valid actionIds with list_actions for the worktree.',
    });
  }
  return action;
}

/**
 * Wrap a domain-service rejection (Nest Bad Request / Not Found) as a
 * structured ToolError so the model gets the real reason plus a way out.
 */
export function actionMutationError(
  error: unknown,
  args: { code: string; remediation: string; fallbackMessage: string },
): ToolError {
  if (error instanceof ToolError) return error;
  const message =
    error instanceof Error && error.message
      ? error.message
      : args.fallbackMessage;
  return new ToolError({
    code: args.code,
    message,
    remediation: args.remediation,
  });
}

/** Compact, model-facing handle for one action — never the output blob. */
export function actionHandle(action: ActionRow) {
  return {
    actionId: action.id,
    name: action.name,
    command:
      action.command.length > MAX_COMMAND_CHARS
        ? `${action.command.slice(0, MAX_COMMAND_CHARS)}…`
        : action.command,
    status: action.status,
    isRunning: action.status === 'running',
    lastExitCode: action.lastExitCode ?? undefined,
    lastRunAt: action.lastRunAt ?? undefined,
    lastFinishedAt: action.lastFinishedAt ?? undefined,
    durationSeconds: runDurationSeconds(action),
    hasOutput: Boolean(action.currentOutput || action.lastOutput),
  };
}

/** Wall-clock seconds of the last completed run, when both stamps are known. */
export function runDurationSeconds(action: ActionRow): number | undefined {
  if (!action.lastRunAt || !action.lastFinishedAt) return undefined;
  const started = Date.parse(action.lastRunAt);
  const finished = Date.parse(action.lastFinishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  if (finished < started) return undefined;
  return Math.round((finished - started) / 1000);
}

/** The output a reader cares about: live buffer while running, else the last run's. */
export function currentOutputOf(action: ActionRow): {
  raw: string;
  source: 'live' | 'last-run';
} {
  if (action.status === 'running') {
    return { raw: action.currentOutput ?? '', source: 'live' };
  }
  return {
    raw: action.lastOutput || action.currentOutput || '',
    source: 'last-run',
  };
}

/**
 * Turn raw pty output into something worth spending tokens on: drop ANSI
 * escapes, collapse `\r`-overwritten progress lines to what the terminal
 * actually shows, then keep the tail (where failures live).
 */
export function tailOutput(
  raw: string,
  maxLines: number,
): {
  text: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
} {
  const cleaned = raw
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => {
      const lastCarriageReturn = line.lastIndexOf('\r');
      return lastCarriageReturn === -1
        ? line
        : line.slice(lastCarriageReturn + 1);
    })
    .join('\n')
    .replace(/\s+$/, '');

  if (!cleaned) {
    return { text: '', totalLines: 0, returnedLines: 0, truncated: false };
  }

  const lines = cleaned.split('\n');
  let truncated = lines.length > maxLines;
  let text = (truncated ? lines.slice(-maxLines) : lines).join('\n');

  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(text.length - MAX_OUTPUT_CHARS);
    truncated = true;
  }

  return {
    text,
    totalLines: lines.length,
    returnedLines: text.split('\n').length,
    truncated,
  };
}

/** Actions are keyed by name within a worktree, case-insensitively. */
export function sameActionName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Guard against persisting an action pointing at a directory that isn't there. */
export async function assertWorktreeExists(
  worktreePath: string,
): Promise<void> {
  try {
    await fs.access(worktreePath);
  } catch {
    throw new ToolError({
      code: 'worktree_not_found',
      message: `Worktree path does not exist: ${worktreePath}`,
      remediation:
        'Pass a sessionId instead, or a worktreePath from assess_worktree_pool / project_overview.',
    });
  }
}
