import type { BackendClient } from "./client";
import { handleForWindow, type TrustedSender } from "../ipc";
import {
  chatId,
  chatObject,
  chatText,
  requestId,
} from "./session-chat-validation";
import { invalidResponse, requestBackendJson } from "./transport";

export function registerChatAttachments(
  client: BackendClient,
  trusted: TrustedSender,
): () => void {
  return handleForWindow("session-chat:upload", trusted, (window, ...args) => {
    const scope = args[0];
    if (
      args.length !== 2 ||
      typeof scope !== "string" ||
      !/^[a-f0-9-]{36}$/.test(scope)
    )
      throw new Error("Invalid backend scope.");
    const raw = chatObject(args[1]),
      taskId = chatId(raw["taskId"]),
      sessionId = chatId(raw["sessionId"]);
    const id = requestId(raw["id"]),
      request = requestId(raw["requestId"]);
    const name = chatText(raw["name"], 255),
      data = chatText(raw["data"], 699052),
      size = raw["size"],
      offset = raw["offset"];
    if (
      !name ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 20 * 1024 * 1024 ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > size ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      offset + Buffer.from(data, "base64").length > size
    )
      throw new Error("Invalid attachment chunk.");
    const next = offset + Buffer.from(data, "base64").length;
    return client.execute(
      window,
      scope,
      `session-chat:${request}:upload`,
      false,
      async (endpoint, signal) => {
        const reply = chatObject(
          await requestBackendJson(
            endpoint,
            {
              path: `/api/desktop-workspace/tasks/${taskId}/sessions/${sessionId}/chat/attachments`,
              method: "POST",
              body: { id, name, size, offset, data },
              limit: 8192,
            },
            signal,
          ),
        );
        const path =
          reply["path"] === null ? null : chatText(reply["path"], 4000);
        if (
          reply["id"] !== id ||
          reply["offset"] !== next ||
          (next === size ? !path : path !== null)
        )
          throw invalidResponse();
        return { id, offset: next, path };
      },
      30000,
    );
  });
}
