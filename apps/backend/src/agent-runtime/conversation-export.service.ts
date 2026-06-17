import { Inject, Injectable, forwardRef } from '@nestjs/common';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import {
  computeTurnChangeDetailsFromItems,
  type TurnChangeDetails,
} from './turn-change-stats.js';

export type ConversationExportPrecision = 'full' | 'medium' | 'small';

export interface ConversationExportOptions {
  precision: ConversationExportPrecision;
  includeChanges: boolean;
  includeIds: boolean;
}

export interface ConversationExportMeta {
  title: string;
  sessionId: number;
  provider: string;
  branch: string;
  exportedAt: string;
}

/** A turn: one user message and everything the agent did until the next user message. */
export interface ConversationExportTurn {
  user: ClaudeTranscriptItem | null;
  /** Intermediate work items (thinking / assistant text / tool_use / tool_result / system). */
  steps: ClaudeTranscriptItem[];
  /** The turn's last non-empty assistant message. */
  finalResponse: ClaudeTranscriptItem | null;
  /** Tool-derived per-turn changes (same source as the transcript's changes pill). */
  changes: TurnChangeDetails | null;
}

export interface ConversationExportModel {
  meta: ConversationExportMeta;
  /** Leading non-user items before the first user message (e.g. system init). */
  preamble: ClaudeTranscriptItem[];
  turns: ConversationExportTurn[];
}

/** Options for the token-economical delta read used by the `read_session` MCP tool. */
export interface ConversationDeltaOptions {
  /** Return only items strictly after this message id. Ignored when `ids` is set. */
  sinceMessageId?: string;
  /** Return only items whose id is in this list (a targeted "zoom"). */
  ids?: string[];
  /** Hard cap on returned items (applied after filtering). */
  limit?: number;
}

/**
 * A single transcript item flattened to the minimum the meta-agent needs to
 * decide what to do next — never the raw block, so a poll stays cheap.
 */
export interface CompactItem {
  id: string;
  role: ClaudeTranscriptItem['kind'];
  /** Short text/summary (truncated). For tool calls this summarises the target. */
  text?: string;
  /** Tool name when this item is a tool_use. */
  tool?: string;
  isError?: boolean;
}

export interface ConversationDeltaResult {
  items: CompactItem[];
  /** Id of the last item in the full history (for the caller's cursor), or null. */
  lastMessageId: string | null;
  /** True when the provider runtime is actively producing — more is coming. */
  running: boolean;
  /** Total items in history (so the caller can reason about how far behind it is). */
  total: number;
  /** True when the result was capped by `limit`. */
  truncated: boolean;
}

const COMPACT_TEXT_LIMIT = 280;

@Injectable()
export class ConversationExportService {
  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
  ) {}

  async export(
    sessionId: number,
    provider: string,
    options: ConversationExportOptions,
  ): Promise<string> {
    const session = await this.sessionsService.findOne(sessionId);
    const items = await this.registry
      .getProvider(provider)
      .getHistory(sessionId);

    const model = buildExportModel(items, {
      title: session.name?.trim() || session.branchName,
      sessionId,
      provider,
      branch: session.branchName,
      exportedAt: new Date().toISOString(),
    });

    return renderMarkdown(model, options);
  }

  /**
   * Token-economical transcript reader for the `read_session` MCP tool. Returns
   * only the items the caller hasn't seen (after `sinceMessageId`) or only the
   * specific `ids` requested, compacted to id/role/short-text — never the raw
   * blocks. Also reports whether the provider runtime is still producing so the
   * agent knows more output is on the way.
   */
  async readDelta(
    sessionId: number,
    provider: string,
    options: ConversationDeltaOptions = {},
  ): Promise<ConversationDeltaResult> {
    const runtime = this.registry.getProvider(provider);
    const items = await runtime.getHistory(sessionId);

    const total = items.length;
    const lastMessageId = total > 0 ? items[total - 1].id : null;

    // Running-guard: if the runtime says the session is actively producing,
    // flag it so the agent keeps polling/awaiting instead of assuming it's done.
    let running = false;
    try {
      const state = (await runtime.getRuntimeState(sessionId)) as {
        sessionState?: string | null;
        runPhase?: string | null;
      };
      running =
        state.sessionState === 'running' || state.runPhase === 'running';
    } catch {
      running = false;
    }

    let selected: ClaudeTranscriptItem[];
    if (options.ids && options.ids.length > 0) {
      const wanted = new Set(options.ids);
      selected = items.filter((item) => wanted.has(item.id));
    } else if (options.sinceMessageId) {
      const index = items.findIndex((item) => item.id === options.sinceMessageId);
      // Unknown cursor (e.g. history was compacted away): fall back to the full
      // list so the caller still gets the latest items rather than nothing.
      selected = index === -1 ? items : items.slice(index + 1);
    } else {
      selected = items;
    }

    const limit = options.limit;
    let truncated = false;
    if (typeof limit === 'number' && selected.length > limit) {
      // Keep the most recent items when capping a forward delta.
      selected = selected.slice(selected.length - limit);
      truncated = true;
    }

    return {
      items: selected.map(toCompactItem),
      lastMessageId,
      running,
      total,
      truncated,
    };
  }
}

/** Flattens a transcript item to the compact shape the meta-agent consumes. */
function toCompactItem(item: ClaudeTranscriptItem): CompactItem {
  const compact: CompactItem = { id: item.id, role: item.kind };
  if (item.kind === 'tool_use') {
    compact.tool = item.toolDisplayName || item.toolName || 'tool';
    const target = toolTarget(item.toolInput);
    if (target) compact.text = truncateText(target);
  } else if (isContentful(item)) {
    compact.text = truncateText(item.content!.trim());
  }
  if (item.isError) compact.isError = true;
  return compact;
}

function truncateText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > COMPACT_TEXT_LIMIT
    ? `${collapsed.slice(0, COMPACT_TEXT_LIMIT)}…`
    : collapsed;
}

// --- pure model building --------------------------------------------------

function isContentful(item: ClaudeTranscriptItem | undefined): boolean {
  return !!item?.content && item.content.trim().length > 0;
}

/**
 * Splits the normalized transcript into turns. A turn starts at each `user` item and
 * runs up to (but excluding) the next `user` item. Items before the first user message
 * become the preamble.
 */
export function buildExportModel(
  items: ClaudeTranscriptItem[],
  meta: ConversationExportMeta,
): ConversationExportModel {
  const preamble: ClaudeTranscriptItem[] = [];
  const turns: ConversationExportTurn[] = [];

  let current: ClaudeTranscriptItem[] | null = null;
  const flush = (group: ClaudeTranscriptItem[]) => {
    turns.push(buildTurn(group));
  };

  for (const item of items) {
    if (item.kind === 'user') {
      if (current) flush(current);
      current = [item];
      continue;
    }
    if (current) current.push(item);
    else preamble.push(item);
  }
  if (current) flush(current);

  return { meta, preamble, turns };
}

function buildTurn(group: ClaudeTranscriptItem[]): ConversationExportTurn {
  const user = group[0]?.kind === 'user' ? group[0] : null;
  const rest = user ? group.slice(1) : group;

  let finalIndex = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].kind === 'assistant' && isContentful(rest[i])) {
      finalIndex = i;
      break;
    }
  }
  const finalResponse = finalIndex === -1 ? null : rest[finalIndex];
  const steps = rest.filter((_, i) => i !== finalIndex);

  // Changes are derived from the full turn items regardless of precision, so a
  // small/medium export still reports accurate per-response change counts.
  const changes = computeTurnChangeDetailsFromItems(group);

  return { user, steps, finalResponse, changes };
}

// --- pure markdown rendering ---------------------------------------------

export function renderMarkdown(
  model: ConversationExportModel,
  options: ConversationExportOptions,
): string {
  const out: string[] = [];
  out.push(renderFrontMatter(model.meta, options));

  if (options.precision !== 'small' && model.preamble.length) {
    const body = renderSteps(model.preamble, options);
    if (body) {
      out.push('## Preamble');
      out.push(body);
    }
  }

  model.turns.forEach((turn, index) => {
    out.push(renderTurn(turn, index + 1, options));
  });

  return (
    out
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

function renderFrontMatter(
  meta: ConversationExportMeta,
  options: ConversationExportOptions,
): string {
  const title = meta.title.replace(/"/g, '\\"');
  return [
    '---',
    `session: "${title}" (#${meta.sessionId})`,
    `provider: ${meta.provider}`,
    `branch: ${meta.branch}`,
    `precision: ${options.precision}`,
    `includeChanges: ${options.includeChanges}`,
    `includeIds: ${options.includeIds}`,
    `exportedAt: ${meta.exportedAt}`,
    '---',
  ].join('\n');
}

function renderTurn(
  turn: ConversationExportTurn,
  number: number,
  options: ConversationExportOptions,
): string {
  const parts: string[] = [`## Turn ${number}`];

  if (turn.user) {
    parts.push(heading('### User', turn.user, options));
    if (isContentful(turn.user)) parts.push(turn.user.content!.trim());
  }

  if (options.precision !== 'small') {
    const work = renderSteps(turn.steps, options);
    if (work) {
      parts.push('### Work');
      parts.push(work);
    }
  }

  if (turn.finalResponse) {
    parts.push(heading('### Response', turn.finalResponse, options));
    parts.push((turn.finalResponse.content ?? '').trim());
  }

  if (options.includeChanges && turn.changes) {
    parts.push('### Changes');
    parts.push(renderChanges(turn.changes, options.precision === 'full'));
  }

  return parts.join('\n\n');
}

/** Renders intermediate items. Returns '' when nothing survives the precision filter. */
function renderSteps(
  items: ClaudeTranscriptItem[],
  options: ConversationExportOptions,
): string {
  const full = options.precision === 'full';
  const resultsByToolUseId = new Map<string, ClaudeTranscriptItem>();
  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId) {
      resultsByToolUseId.set(item.toolUseId, item);
    }
  }

  const blocks: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'thinking': {
        if (!full || !isContentful(item)) break;
        blocks.push(
          `${idLabel('[thinking]', item, options)}\n${item.content!.trim()}`,
        );
        break;
      }
      case 'assistant': {
        if (!isContentful(item)) break;
        blocks.push(
          `${idLabel('[assistant]', item, options)}\n${item.content!.trim()}`,
        );
        break;
      }
      case 'tool_use': {
        const toolUseId = item.toolUseId || item.id;
        const result = resultsByToolUseId.get(toolUseId) ?? null;
        blocks.push(renderToolCall(item, result, options));
        break;
      }
      case 'system': {
        if (!full || !isContentful(item)) break;
        blocks.push(
          `${idLabel('[system]', item, options)}\n${item.content!.trim()}`,
        );
        break;
      }
      // tool_result is consumed via its paired tool_use above; standalone results are
      // rare and intentionally omitted to avoid duplicate/orphan noise.
      default:
        break;
    }
  }
  return blocks.join('\n\n');
}

function renderToolCall(
  call: ClaudeTranscriptItem,
  result: ClaudeTranscriptItem | null,
  options: ConversationExportOptions,
): string {
  const name = call.toolDisplayName || call.toolName || 'tool';
  const target = toolTarget(call.toolInput);
  const header = idLabel(
    `[tool] ${name}${target ? ` — ${target}` : ''}`,
    call,
    options,
  );

  const lines = [header];
  const input = renderToolInput(call);
  if (input) {
    lines.push('input:');
    lines.push(input);
  }

  if (options.precision === 'full' && result && isContentful(result)) {
    lines.push(result.isError ? 'output (error):' : 'output:');
    lines.push(fence(result.content!.trimEnd()));
  }

  return lines.join('\n');
}

function renderChanges(changes: TurnChangeDetails, withHunks: boolean): string {
  const lines = [
    `${changes.files} ${changes.files === 1 ? 'file' : 'files'} ` +
      `(${signed(changes.additions, '+')} ${signed(changes.deletions, '−')})`,
  ];
  for (const file of changes.filesChanged) {
    lines.push(
      `- ${statusLetter(file.status)} ${file.path} ` +
        `(${signed(file.additions, '+')} ${signed(file.deletions, '−')})`,
    );
    if (withHunks) {
      for (const hunk of file.hunks) {
        const patch = hunk.patch ?? buildHunkPatch(hunk);
        if (patch.trim()) lines.push(indent(fence(patch.trimEnd()), '  '));
      }
    }
  }
  return lines.join('\n');
}

// --- rendering helpers ----------------------------------------------------

function heading(
  base: string,
  item: ClaudeTranscriptItem,
  options: ConversationExportOptions,
): string {
  return idLabel(base, item, options);
}

function idLabel(
  base: string,
  item: ClaudeTranscriptItem,
  options: ConversationExportOptions,
): string {
  return options.includeIds && item.id ? `${base} {#${item.id}}` : base;
}

/** Wraps body in a code fence long enough to never collide with backtick runs inside it. */
function fence(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${body}\n${ticks}`;
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

function signed(n: number, sign: string): string {
  return `${sign}${n}`;
}

function statusLetter(status: 'created' | 'modified' | 'deleted'): string {
  return status === 'created' ? 'A' : status === 'deleted' ? 'D' : 'M';
}

function buildHunkPatch(hunk: {
  oldString: string;
  newString: string;
}): string {
  const out: string[] = [];
  for (const line of hunk.oldString ? hunk.oldString.split('\n') : []) {
    out.push(`- ${line}`);
  }
  for (const line of hunk.newString ? hunk.newString.split('\n') : []) {
    out.push(`+ ${line}`);
  }
  return out.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return '';
}

/** Short, human-friendly target shown in a tool-call header (a path, pattern, etc.). */
function toolTarget(input: unknown): string {
  const record = asRecord(input);
  if (!record) return '';
  return firstString(record, [
    'file_path',
    'filePath',
    'notebook_path',
    'notebookPath',
    'path',
    'pattern',
  ]);
}

/**
 * Renders a tool's input as a ready-to-embed Markdown block (fences included) in a
 * readable, LLM-friendly form — never as escaped JSON. Common tools get a tailored
 * layout; everything else falls back to a key/value list where multi-line string
 * values are placed in their own fenced block.
 */
function renderToolInput(call: ClaudeTranscriptItem): string {
  const record = asRecord(call.toolInput);
  if (!record) {
    const raw = asString(call.toolInput).trim();
    return raw ? fence(raw) : '';
  }
  const normalized = (call.toolName || '').toLowerCase().replace(/[_-]/g, '');

  if (normalized === 'bash') {
    const command = firstString(record, ['command', 'cmd']);
    const description = firstString(record, ['description']);
    const body = [description ? `# ${description}` : '', command]
      .filter(Boolean)
      .join('\n');
    return body ? fence(body) : '';
  }

  if (normalized === 'write') {
    const path = firstString(record, ['file_path', 'filePath', 'path']);
    const content = asString(record['content']);
    const body = [path, content].filter(Boolean).join('\n');
    return body ? fence(body) : '';
  }

  if (normalized === 'edit') {
    const diff = renderEditDiff(
      asString(record['old_string']),
      asString(record['new_string']),
    );
    return diff ? fence(diff) : '';
  }

  if (normalized === 'multiedit') {
    const raw = Array.isArray(record['edits'])
      ? (record['edits'] as unknown[])
      : [];
    const body = raw
      .map((entry, index) => {
        const edit = asRecord(entry);
        if (!edit) return '';
        const diff = renderEditDiff(
          asString(edit['old_string']),
          asString(edit['new_string']),
        );
        return raw.length > 1 ? `# Edit ${index + 1}\n${diff}` : diff;
      })
      .filter(Boolean)
      .join('\n\n');
    return body ? fence(body) : '';
  }

  return renderGenericInput(record);
}

function renderEditDiff(oldString: string, newString: string): string {
  const out: string[] = [];
  for (const line of oldString ? oldString.split('\n') : [])
    out.push(`- ${line}`);
  for (const line of newString ? newString.split('\n') : [])
    out.push(`+ ${line}`);
  return out.join('\n');
}

function renderGenericInput(record: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value == null) continue;
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        lines.push(`${key}:`, fence(value));
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n');
}
