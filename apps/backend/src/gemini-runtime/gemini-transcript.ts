import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { AgentToolKind } from '../claude-runtime/claude-runtime.types.js';
import type {
  AcpContentBlock,
  AcpPlanEntry,
  AcpToolCall,
  AcpToolCallContent,
  AcpToolKind,
} from './gemini-runtime.types.js';

/**
 * `session/set_mode` makes gemini-cli echo a synthetic assistant chunk of the
 * form `[MODE_UPDATE] plan`. It is protocol bookkeeping, not model output, and
 * must never reach the transcript.
 */
const MODE_UPDATE_PREFIX = '[MODE_UPDATE]';

/**
 * Gemini opens every session by injecting a `<session_context>` block — OS,
 * date, workspace directories and a 200-entry directory tree — as the first
 * user message. Showing it would bury the user's actual first prompt.
 */
const SESSION_CONTEXT_PATTERN =
  /<session_context>[\s\S]*?<\/session_context>\s*/g;

export function isModeUpdateChunk(text: string): boolean {
  return text.trimStart().startsWith(MODE_UPDATE_PREFIX);
}

export function stripSessionContext(text: string): string {
  return text.replace(SESSION_CONTEXT_PATTERN, '').trim();
}

/** Flattens an ACP content block to the plain text the transcript renders. */
export function contentBlockToText(block: AcpContentBlock | undefined): string {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'resource_link':
      return block.name ? `[${block.name}](${block.uri})` : block.uri;
    case 'resource': {
      const resource = block.resource as Record<string, unknown> | undefined;
      const text = resource?.['text'];
      return typeof text === 'string' ? text : '';
    }
    // Images and audio carry no text; the workspace renders attachments from
    // the tool/message payload instead.
    default:
      return '';
  }
}

/**
 * ACP tool kinds are coarse (`read`/`edit`/`execute`/…). They are the fallback
 * when the tool's own name is not recoverable from the call.
 */
const ACP_KIND_TO_TOOL_KIND: Record<AcpToolKind, AgentToolKind> = {
  read: 'read',
  edit: 'edit',
  // No dedicated delete/move kind exists; both mutate files, so they render on
  // the write card with the ACP title carrying the specifics.
  delete: 'write',
  move: 'write',
  search: 'grep',
  execute: 'bash',
  think: 'unknown',
  fetch: 'web_fetch',
  switch_mode: 'unknown',
  other: 'unknown',
};

/**
 * Best-effort recovery of the underlying Gemini tool name.
 *
 * ACP's `tool_call` carries a human `title` and a coarse `kind`, not the tool
 * id, so we look in the places gemini-cli is known to put it before falling
 * back to the title itself.
 */
function extractToolName(call: AcpToolCall): string | undefined {
  const meta = (call as unknown as Record<string, unknown>)['_meta'];
  if (meta && typeof meta === 'object') {
    const name = (meta as Record<string, unknown>)['toolName'];
    if (typeof name === 'string' && name.trim()) return name;
  }
  const raw = call.rawInput;
  if (raw && typeof raw === 'object') {
    const name = (raw as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.trim()) return name;
  }
  return typeof call.title === 'string' && call.title.trim()
    ? call.title
    : undefined;
}

export interface CanonicalGeminiTool {
  toolKind: AgentToolKind;
  toolDisplayName: string;
  toolInput: unknown;
  providerToolName: string;
}

/**
 * Maps an ACP tool call onto the shared tool taxonomy so Gemini tool cards
 * render with the same components as Claude's and Codex's.
 *
 * The tool's own name is tried first through the shared normalizer (which knows
 * Gemini's `read_file`/`replace`/`run_shell_command`/… names); the ACP `kind`
 * is only consulted when that yields `unknown`, so a renamed Gemini tool still
 * lands on a sensible card.
 */
export function canonicalizeGeminiTool(call: AcpToolCall): CanonicalGeminiTool {
  const toolName = extractToolName(call);
  const rawInput =
    call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const byName = canonicalizeAgentTool(toolName, rawInput);
  const providerToolName = toolName ?? call.kind ?? 'Tool';

  if (byName.toolKind !== 'unknown') {
    return { ...byName, providerToolName };
  }

  const kind = call.kind ? ACP_KIND_TO_TOOL_KIND[call.kind] : undefined;
  if (kind && kind !== 'unknown') {
    // Re-run the normalizer under a canonical name so the tool input is shaped
    // (e.g. `file_path` filled in from `path`) the way the cards expect.
    const byKind = canonicalizeAgentTool(kind, rawInput);
    return {
      toolKind: kind,
      toolDisplayName: call.title?.trim() || byKind.toolDisplayName,
      toolInput: byKind.toolInput,
      providerToolName,
    };
  }

  return {
    toolKind: 'unknown',
    toolDisplayName: call.title?.trim() || byName.toolDisplayName,
    toolInput: rawInput,
    providerToolName,
  };
}

/**
 * Renders the result side of a tool call. ACP delivers it as a list of content
 * blocks, unified diffs, or a terminal handle; the transcript shows text.
 */
export function toolCallContentToText(
  content: AcpToolCallContent[] | undefined,
): string {
  if (!Array.isArray(content) || content.length === 0) return '';
  return content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      if (entry.type === 'content') return contentBlockToText(entry.content);
      if (entry.type === 'diff') return renderDiff(entry);
      if (entry.type === 'terminal') return '';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function renderDiff(entry: {
  path: string;
  oldText?: string | null;
  newText: string;
}): string {
  const header = `--- ${entry.path}\n+++ ${entry.path}`;
  const oldLines = (entry.oldText ?? '').split('\n');
  const newLines = (entry.newText ?? '').split('\n');
  const body = [
    ...oldLines.filter(Boolean).map((line) => `-${line}`),
    ...newLines.filter(Boolean).map((line) => `+${line}`),
  ].join('\n');
  return `${header}\n${body}`;
}

/** Extracts the paths an ACP tool call touched, for the file-scoped cards. */
export function toolCallPaths(call: AcpToolCall): string[] {
  const fromLocations = Array.isArray(call.locations)
    ? call.locations
        .map((location) => location?.path)
        .filter((path): path is string => typeof path === 'string')
    : [];
  const fromDiffs = Array.isArray(call.content)
    ? call.content
        .filter(
          (entry): entry is Extract<AcpToolCallContent, { type: 'diff' }> =>
            Boolean(entry) && entry.type === 'diff',
        )
        .map((entry) => entry.path)
    : [];
  return [...new Set([...fromLocations, ...fromDiffs])];
}

/**
 * ACP plans arrive as structured entries. The workspace renders plans as
 * markdown (the same shape Codex's `plan` items produce), so convert to a
 * checklist where the status is legible at a glance.
 */
export function planEntriesToMarkdown(entries: AcpPlanEntry[]): string {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .map((entry) => {
      const box =
        entry?.status === 'completed'
          ? '[x]'
          : entry?.status === 'in_progress'
            ? '[~]'
            : '[ ]';
      const content = typeof entry?.content === 'string' ? entry.content : '';
      return `- ${box} ${content}`.trimEnd();
    })
    .join('\n');
}
