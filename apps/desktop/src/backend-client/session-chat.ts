import { handleForWindow, type TrustedSender } from "../ipc";
import type { BackendClient } from "./client";
import {
  chatId,
  chatObject,
  chatText,
  parseChatAction,
  parseChatPage,
  requestId,
} from "./session-chat-validation";
import { BackendRequestError, requestBackendJson } from "./transport";

/** Transport stays on the existing per-window lease, including capability routing and cancellation. */
export function registerSessionChatIpc(
  client: BackendClient,
  trusted: TrustedSender,
): () => void {
  const scope = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
      throw new Error("A backend scope is required.");
    return value;
  };
  const path = (task: number, session: number) =>
    `/api/desktop-workspace/tasks/${task}/sessions/${session}/chat`;
  const read = handleForWindow(
    "session-chat:read",
    trusted,
    (window, ...args) => {
      if (args.length !== 2) throw new Error("Invalid conversation arguments.");
      const scopeId = scope(args[0]),
        raw = chatObject(args[1]),
        taskId = chatId(raw["taskId"]),
        sessionId = chatId(raw["sessionId"]);
      const key = "session-chat:" + requestId(raw["requestId"]),
        query = new URLSearchParams();
      if (raw["after"] !== undefined)
        query.set("after", chatText(raw["after"], 200));
      if (raw["before"] !== undefined)
        query.set("before", chatText(raw["before"]));
      return client.execute(
        window,
        scopeId,
        `${key}:${taskId}:${sessionId}:${query}`,
        false,
        async (endpoint, signal) =>
          parseChatPage(
            await requestBackendJson(
              endpoint,
              {
                path: path(taskId, sessionId) + "?" + query,
                limit: 4 * 1024 * 1024,
              },
              signal,
            ),
            taskId,
            sessionId,
          ),
        15000,
      );
    },
  );
  const command = handleForWindow(
    "session-chat:command",
    trusted,
    (window, ...args) => {
      if (args.length !== 2) throw new Error("Invalid conversation arguments.");
      const scopeId = scope(args[0]),
        raw = chatObject(args[1]),
        taskId = chatId(raw["taskId"]),
        sessionId = chatId(raw["sessionId"]),
        action = parseChatAction(raw["action"]);
      return client.execute(
        window,
        scopeId,
        null,
        true,
        async (endpoint, signal) => {
          const reply = chatObject(
            await requestBackendJson(
              endpoint,
              {
                path: path(taskId, sessionId),
                method: "POST",
                body: action,
                limit: 4096,
              },
              signal,
            ),
          );
          if (reply["accepted"] !== true)
            throw new BackendRequestError({
              code: "invalid-response",
              message: "The machine did not confirm the conversation action.",
            });
          return { accepted: true as const };
        },
        30000,
      );
    },
  );
  const cancel = handleForWindow(
    "session-chat:cancel",
    trusted,
    (window, ...args) => {
      if (args.length !== 2)
        throw new Error("Invalid conversation cancellation.");
      client.cancel(
        window,
        scope(args[0]),
        "session-chat:" + requestId(args[1]),
      );
    },
  );
  const content = handleForWindow(
    "session-chat:content",
    trusted,
    (window, ...args) => {
      if (args.length !== 2)
        throw new Error("Invalid conversation content arguments.");
      const scopeId = scope(args[0]),
        raw = chatObject(args[1]),
        taskId = chatId(raw["taskId"]),
        sessionId = chatId(raw["sessionId"]),
        id = chatText(raw["itemId"]),
        part = raw["part"],
        offset = raw["offset"];
      if (
        (part !== "input" && part !== "text") ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new Error("Invalid content window.");
      const query = new URLSearchParams({
        itemId: id,
        part,
        offset: String(offset),
      });
      return client.execute(
        window,
        scopeId,
        `session-chat:${requestId(raw["requestId"])}:${taskId}:${sessionId}:content:${query}`,
        false,
        async (endpoint, signal) => {
          const reply = chatObject(
            await requestBackendJson(
              endpoint,
              {
                path: path(taskId, sessionId) + "/content?" + query,
                limit: 128 * 1024,
              },
              signal,
            ),
          );
          if (
            reply["itemId"] !== id ||
            reply["part"] !== part ||
            reply["offset"] !== offset ||
            typeof reply["total"] !== "number" ||
            !Number.isSafeInteger(reply["total"]) ||
            reply["total"] < offset ||
            (reply["nextOffset"] !== null &&
              (typeof reply["nextOffset"] !== "number" ||
                !Number.isSafeInteger(reply["nextOffset"]) ||
                reply["nextOffset"] <= offset ||
                reply["nextOffset"] > reply["total"]))
          )
            throw new Error("Invalid content reply.");
          return {
            itemId: id,
            part,
            offset,
            total: reply["total"],
            nextOffset: reply["nextOffset"],
            text: chatText(reply["text"], 16000),
          };
        },
      );
    },
  );
  return () => {
    read();
    command();
    cancel();
    content();
  };
}
