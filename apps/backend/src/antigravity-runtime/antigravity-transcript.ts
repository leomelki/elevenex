import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { AgentToolKind } from '../claude-runtime/claude-runtime.types.js';
import type { AntigravityToolInfo } from './antigravity-runtime.types.js';

export interface CanonicalAntigravityTool {
  toolKind: AgentToolKind;
  toolDisplayName: string;
  toolInput: unknown;
  providerToolName: string;
}

/**
 * `agy`'s own tool names and parameter keys, mapped onto the shared taxonomy.
 *
 * Two things make this table necessary rather than optional. `agy` names its
 * tools nothing like Claude/Codex/Gemini do (`view_file`, not `Read`;
 * `run_command`, not `Bash`), and it spells parameters in PascalCase
 * (`AbsolutePath`, `CommandLine`, `TargetFile`). Without the mapping every
 * Antigravity tool call but `notebook_edit` fell through to the `unknown`
 * card, so a whole session rendered as raw JSON blobs instead of Read / Edit /
 * Run cards.
 *
 * `alias` is a name the shared `canonicalizeAgentTool` already recognizes;
 * `params` renames `agy`'s keys onto the canonical ones the tool cards read
 * (`file_path`, `command`, `pattern`, `path`, `url`, `query`). Original keys
 * are preserved alongside the renamed ones so nothing is hidden from the raw
 * parameter view.
 *
 * Names come from the 57-tool list `agy` 1.1.22 reports in its `init` event.
 * Parameter spellings are captured from live `tool_info` payloads except where
 * marked inferred below — an inferred key that turns out wrong simply does not
 * match, leaving the card's target blank rather than breaking it. See
 * docs/antigravity-provider-flow.md.
 *
 * Tools left out of the table — the `browser_*` family, subagent/task
 * management, `command_status`, `finish`, `wait` — have no counterpart in the
 * shared taxonomy and keep rendering as `unknown`, which shows the raw name
 * and parameters.
 */
const AGY_TOOL_MAP: Record<
  string,
  { alias: string; params?: Record<string, string | string[]> }
> = {
  view_file: { alias: 'read_file', params: { AbsolutePath: 'file_path' } },
  // The "List" card reads `pattern` for its one-line target, so the directory
  // is written to both keys rather than leaving the card with a blank target.
  list_dir: {
    alias: 'list_directory',
    params: { DirectoryPath: ['path', 'pattern'] },
  },
  find_by_name: {
    alias: 'glob',
    params: { Pattern: 'pattern', SearchDirectory: 'path' },
  },
  grep_search: {
    alias: 'grep',
    params: { Query: 'pattern', SearchPath: 'path' },
  },
  run_command: {
    alias: 'bash',
    params: { CommandLine: 'command', Cwd: 'cwd' },
  },
  write_to_file: {
    alias: 'write_file',
    params: { TargetFile: 'file_path', CodeContent: 'content' },
  },
  replace_file_content: { alias: 'edit', params: { TargetFile: 'file_path' } },
  // Inferred: `agy` routed every edit request observed so far through
  // `replace_file_content`, so these two never showed up live. They share that
  // tool's `TargetFile` spelling.
  multi_replace_file_content: {
    alias: 'edit',
    params: { TargetFile: 'file_path' },
  },
  sed_file: { alias: 'edit', params: { TargetFile: 'file_path' } },
  notebook_edit: {
    alias: 'notebook_edit',
    // Inferred.
    params: { TargetFile: 'notebook_path', NotebookPath: 'notebook_path' },
  },
  read_url_content: { alias: 'web_fetch', params: { Url: 'url' } },
  // `search_web` is the one tool that already spells its parameter in
  // lowercase (`query`), which is what the card reads.
  search_web: { alias: 'web_search' },
  ask_question: { alias: 'ask_user_question' },
  call_mcp_tool: { alias: 'mcp' },
};

/**
 * Rewrites `agy`'s PascalCase parameter keys onto the canonical names the
 * shared tool cards read, keeping the originals so the raw view stays whole.
 * One source key may feed several canonical keys (see `list_dir`).
 */
function remapParameters(
  parameters: unknown,
  params: Record<string, string | string[]> | undefined,
): unknown {
  if (!params) return parameters;
  if (
    !parameters ||
    typeof parameters !== 'object' ||
    Array.isArray(parameters)
  )
    return parameters;
  const data = parameters as Record<string, unknown>;
  const mapped: Record<string, unknown> = { ...data };
  for (const [from, to] of Object.entries(params)) {
    if (!(from in data)) continue;
    for (const key of Array.isArray(to) ? to : [to]) mapped[key] = data[from];
  }
  return mapped;
}

/**
 * Maps an `agy` `tool_info` payload onto the shared tool taxonomy so
 * Antigravity tool cards render with the same components as every other
 * provider's.
 *
 * A name absent from `AGY_TOOL_MAP` is still passed to the shared normalizer
 * under its own name — that keeps any tool the shared table happens to know
 * working, and anything genuinely unrecognized renders as `unknown` with the
 * raw name shown, the same as an unrecognized tool from any other provider.
 */
export function canonicalizeAntigravityTool(
  info: AntigravityToolInfo,
): CanonicalAntigravityTool {
  const name =
    typeof info.name === 'string' && info.name.trim() ? info.name : undefined;
  const mapping = name ? AGY_TOOL_MAP[name] : undefined;
  const canonical = canonicalizeAgentTool(
    mapping?.alias ?? name,
    remapParameters(info.parameters, mapping?.params),
  );
  return { ...canonical, providerToolName: name ?? 'Tool' };
}

/**
 * Normalizes `tool_info.error` to a message string.
 *
 * `agy` reports tool failures as an object (`{type, message}`), not a string —
 * e.g. `{"type":"TOOL_ERROR","message":"permission check failed ..."}`. A
 * string is still accepted so a future/plain-string shape keeps rendering.
 */
export function toolInfoErrorMessage(info: AntigravityToolInfo): string | null {
  const error = info.error;
  if (!error) return null;
  if (typeof error === 'string') return error || null;
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    const type = (error as { type?: unknown }).type;
    if (typeof type === 'string' && type) return type;
    return 'Tool call failed.';
  }
  return null;
}

/** Renders the result side of a tool call: `output` on success, `error` on failure. */
export function toolInfoResultText(info: AntigravityToolInfo): string {
  const error = toolInfoErrorMessage(info);
  if (error) return error;
  if (typeof info.output === 'string') return info.output;
  return '';
}

/** True once a `tool_info` payload has settled (has output or an error). */
export function toolInfoIsComplete(info: AntigravityToolInfo): boolean {
  return typeof info.output === 'string' || toolInfoErrorMessage(info) !== null;
}
