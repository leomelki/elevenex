import { invalid } from "./session-chat-values";
import type { BackendClient } from "./client";
import { handleForWindow, type TrustedSender } from "../ipc";
import {
  chatId,
  chatObject,
  chatText,
  requestId,
} from "./session-chat-validation";
import { requestBackendJson } from "./transport";

export function registerSessionChatMedia(
  client: BackendClient,
  trusted: TrustedSender,
): () => void {
  return handleForWindow("session-chat:media", trusted, (window, ...args) => {
    const scope = args[0];
    if (
      args.length !== 2 ||
      typeof scope !== "string" ||
      !/^[a-f0-9-]{36}$/.test(scope)
    )
      throw new Error("A backend scope is required.");
    const raw = chatObject(args[1]);
    const taskId = chatId(raw["taskId"]),
      sessionId = chatId(raw["sessionId"]);
    const itemId = chatText(raw["itemId"]),
      mediaId = chatText(raw["mediaId"], 2);
    if (!itemId || !/^\d{1,2}$/.test(mediaId))
      throw new Error("Invalid image reference.");
    const query = new URLSearchParams({ itemId, mediaId });
    return client.execute(
      window,
      scope,
      `session-chat:${requestId(raw["requestId"])}:${taskId}:${sessionId}:media:${query}`,
      false,
      async (endpoint, signal) => {
        const reply = chatObject(
          await requestBackendJson(
            endpoint,
            {
              path: `/api/desktop-workspace/tasks/${taskId}/sessions/${sessionId}/chat/media?${query}`,
              limit: 12 * 1024 * 1024,
            },
            signal,
          ),
        );
        const source = chatText(reply["source"], 12 * 1024 * 1024);
        if (
          reply["itemId"] !== itemId ||
          reply["mediaId"] !== mediaId ||
          !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
            source,
          )
        )
          throw invalid();
        return { itemId, mediaId, source };
      },
    );
  });
}
