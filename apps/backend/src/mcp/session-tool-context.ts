import { TASK_FINISH_INSTRUCTIONS } from './task-finish-instructions.js';
import { getElevenexProxyPort } from '../config/ports.js';

/** Shared runtime configuration; credentials stay out of prompts and repository files. */
export function elevenexMcpUrl(): string {
  return (
    process.env.ELEVENEX_MCP_URL?.trim() ||
    `http://127.0.0.1:${getElevenexProxyPort()}/api/mcp`
  );
}

export const SESSION_TOOL_INSTRUCTIONS = `You are working inside an Elevenex coding session. Continue this task with your native coding tools and supplied working directory. Elevenex tools are also connected. Tools advertising current-session defaults resolve omitted scope from the caller; use those defaults directly. Call get_current_session only when an operation needs unknown Elevenex IDs or you need to resolve uncertainty about the current task/checkout assignment. It identifies your authenticated caller independently of UI focus. Do not call it routinely at startup or on each turn. Tasks own checkout allocation and durable history: use get_task/list_tasks when you need task lifecycle or related conversation information, create_task for isolated parallel work or snapshot review, and open_task_session to reuse a task conversation. create_session/fork_session share that task’s files. Task paths may change after finish/reopen; never use historical paths as current checkout identity. Prefer bounded searches, transcript deltas, and notes/draft windows. For a remote service, list_port_forwards/create_port_forward manage listeners on the user's connected desktop; get/start/stop/remove_port_forward inspect or control saved forwards in the project's Ports UI. Do not prompt, interrupt, reset, or archive your own session. ${TASK_FINISH_INSTRUCTIONS}`;
