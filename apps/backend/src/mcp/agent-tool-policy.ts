/**
 * Autonomy permission policy for the meta-agent's elevenex tool calls.
 *
 * This is a leaf constants module (no DI, no imports) so the claude-runtime can
 * import it without coupling to the whole MCP module.
 *
 * The full MCP tool name the SDK reports is `mcp__<server>__<tool>`; our server
 * is registered as `elevenex`.
 */
export const ELEVENEX_MCP_TOOL_PREFIX = 'mcp__elevenex__';

/**
 * Elevenex tools that perform a risky or irreversible action and therefore must
 * surface a human approval in "review" autonomy (auto-allowed only in "full").
 *
 * Covers every advertised destructive tool, including finishing tasks and
 * deleting projects. Legacy destructive names stay gated for resumed clients.
 * remove_repo leaves files on disk but irreversibly deletes Elevenex state.
 */
export const DESTRUCTIVE_ELEVENEX_TOOLS: ReadonlySet<string> = new Set([
  `${ELEVENEX_MCP_TOOL_PREFIX}steal_worktree`,
  `${ELEVENEX_MCP_TOOL_PREFIX}reset_session`,
  `${ELEVENEX_MCP_TOOL_PREFIX}remove_repo`,
  `${ELEVENEX_MCP_TOOL_PREFIX}delete_worktree`,
  `${ELEVENEX_MCP_TOOL_PREFIX}delete_session_folder`,
  `${ELEVENEX_MCP_TOOL_PREFIX}finish_task`,
  `${ELEVENEX_MCP_TOOL_PREFIX}delete_project`,
]);

/** True for any `mcp__elevenex__*` tool. */
export function isElevenexTool(toolName: string): boolean {
  return toolName.startsWith(ELEVENEX_MCP_TOOL_PREFIX);
}

/** True for an elevenex tool that needs approval in "review" autonomy. */
export function isDestructiveElevenexTool(toolName: string): boolean {
  return DESTRUCTIVE_ELEVENEX_TOOLS.has(toolName);
}
