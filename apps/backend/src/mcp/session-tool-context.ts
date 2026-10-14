import { getElevenexProxyPort } from '../config/ports.js';

/** Shared runtime configuration; credentials stay out of prompts and repository files. */
export function elevenexMcpUrl(): string {
  return (
    process.env.ELEVENEX_MCP_URL?.trim() ||
    `http://127.0.0.1:${getElevenexProxyPort()}/api/mcp`
  );
}

export const SESSION_TOOL_INSTRUCTIONS = `You are working inside an Elevenex coding session. Continue this task with your native coding tools. Elevenex tools are also connected: get_current_session discovers your authenticated sessionId, taskId/workspaceId, projectId, repoId, branch, and assigned worktree, independently of UI focus. Tools advertising current-session defaults resolve omitted scope from the caller. Tasks own checkout allocation and durable history: use get_task/list_tasks for context, create_task for isolated parallel work or snapshot review, and open_task_session to reuse a task conversation. create_session/fork_session share that task’s files. Task paths may change after finish/reopen; never use historical paths as current checkout identity. Prefer bounded searches, transcript deltas, and notes/draft windows. For a remote service, list_port_forwards/create_port_forward manage listeners on the user's connected desktop; get/start/stop/remove_port_forward inspect or control saved forwards in the project's Ports UI. Do not prompt, interrupt, reset, archive your own session or finish its task from this turn; ask the human to finish it from Elevenex after work ends.`;
