import { handleForWindow, type TrustedSender } from "../ipc";
import type { BackendClient } from "./client";
import {
  chatId,
  chatObject,
  chatText,
  requestId,
  parseChatAgentPage,
} from "./session-chat-validation";
import { requestBackendJson } from "./transport";

export function registerChatAgents(
  client: BackendClient,
  trusted: TrustedSender,
): () => void {
  return handleForWindow("session-chat:agent", trusted, (window, ...args) => {
    if (
      args.length !== 2 ||
      typeof args[0] !== "string" ||
      !/^[a-f0-9-]{36}$/.test(args[0])
    )
      throw new Error("A backend scope is required.");
    const scopeId = args[0],
      raw = chatObject(args[1]);
    const taskId = chatId(raw["taskId"]),
      sessionId = chatId(raw["sessionId"]);
    const agentId = chatText(raw["agentId"], 256);
    if (!/^[\w-]{1,256}$/.test(agentId)) throw new Error("Invalid agent.");
    const before =
      raw["before"] === undefined ? undefined : chatText(raw["before"], 2000);
    if (before !== undefined && !/^[\w-]+$/.test(before))
      throw new Error("Invalid agent cursor.");
    const query = new URLSearchParams({
      agentId,
      ...(before ? { before } : {}),
    });
    return client.execute(
      window,
      scopeId,
      `session-chat:${requestId(raw["requestId"])}:${taskId}:${sessionId}:agent:${query}`,
      false,
      async (endpoint, signal) =>
        parseChatAgentPage(
          await requestBackendJson(
            endpoint,
            {
              path: `/api/desktop-workspace/tasks/${taskId}/sessions/${sessionId}/chat/agent?${query}`,
              limit: 1024 * 1024,
            },
            signal,
          ),
          agentId,
        ),
    );
  });
}
