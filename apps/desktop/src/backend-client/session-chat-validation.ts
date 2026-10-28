import type {
  SessionChatAction,
  SessionChatEvent,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
} from "@elevenex/shared";
import { BackendRequestError } from "./transport";
const invalid = () =>
  new BackendRequestError({
    code: "invalid-response",
    message: "The machine returned incompatible conversation data.",
  });
export function chatObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
export function chatText(value: unknown, max = 1000): string {
  if (typeof value !== "string" || value.length > max) throw invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    throw invalid();
  return value;
}
function nullable(value: unknown, max = 1000): string | null {
  return value === null ? null : chatText(value, max);
}
function array<T>(
  value: unknown,
  max: number,
  parse: (value: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(parse);
}
export function chatId(value: unknown): number {
  const id = number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw invalid();
  return id;
}
export function requestId(value: unknown): string {
  const id = chatText(value, 100);
  if (!/^[\w-]{1,100}$/.test(id)) throw invalid();
  return id;
}
function item(value: unknown): SessionChatItem {
  const raw = chatObject(value),
    kind = raw["kind"];
  if (
    kind !== "user" &&
    kind !== "assistant" &&
    kind !== "thinking" &&
    kind !== "tool_use" &&
    kind !== "tool_result" &&
    kind !== "system" &&
    kind !== "error"
  )
    throw invalid();
  return {
    id: chatText(raw["id"]),
    kind,
    text: chatText(raw["text"], 16100),
    timestamp: chatText(raw["timestamp"]),
    toolId: nullable(raw["toolId"]),
    toolName: nullable(raw["toolName"]),
    toolKind: nullable(raw["toolKind"]),
    input: chatText(raw["input"], 16100),
    error: bool(raw["error"]),
    truncated: bool(raw["truncated"]),
  };
}
function state(value: unknown): SessionChatState {
  const raw = chatObject(value),
    phase = raw["phase"];
  if (
    phase !== "idle" &&
    phase !== "running" &&
    phase !== "waiting" &&
    phase !== "error"
  )
    throw invalid();
  const permission =
    raw["permission"] === null ? null : chatObject(raw["permission"]);
  const question =
    raw["question"] === null ? null : chatObject(raw["question"]);
  const context = raw["context"] === null ? null : chatObject(raw["context"]);
  return {
    provider: chatText(raw["provider"]),
    ...(raw["providers"] === undefined
      ? {}
      : {
          providers: array(raw["providers"], 32, (value) => {
            const provider = chatObject(value);
            return {
              id: chatText(provider["id"]),
              label: chatText(provider["label"]),
            };
          }),
        }),
    ...(raw["providerLocked"] === undefined
      ? {}
      : { providerLocked: bool(raw["providerLocked"]) }),
    phase,
    canInterrupt: bool(raw["canInterrupt"]),
    error: nullable(raw["error"]),
    model: nullable(raw["model"]),
    reasoning: nullable(raw["reasoning"]),
    plan: bool(raw["plan"]),
    permissionMode: nullable(raw["permissionMode"]),
    permissionModes: array(raw["permissionModes"], 20, (v) => chatText(v)),
    models: array(raw["models"], 100, (value) => {
      const m = chatObject(value);
      return { id: chatText(m["id"]), label: chatText(m["label"]) };
    }),
    context: context && {
      tokens: number(context["tokens"]),
      limit: number(context["limit"]),
      percentage: number(context["percentage"], 100),
    },
    queue: array(raw["queue"], 50, (value) => {
      const q = chatObject(value);
      return { id: chatText(q["id"]), text: chatText(q["text"], 16100) };
    }),
    queuePaused: bool(raw["queuePaused"]),
    permission: permission && {
      id: chatText(permission["id"]),
      title: chatText(permission["title"]),
      description: chatText(permission["description"], 4100),
      input: chatText(permission["input"], 16100),
      allowAlways: bool(permission["allowAlways"]),
    },
    question: question && {
      id: chatText(question["id"]),
      message: chatText(question["message"], 4100),
      url: nullable(question["url"]),
      questions: array(question["questions"], 20, (value) => {
        const q = chatObject(value);
        return {
          id: chatText(q["id"]),
          question: chatText(q["question"], 4100),
          multiple: bool(q["multiple"]),
          options: array(q["options"], 30, (value) => {
            const o = chatObject(value);
            return {
              label: chatText(o["label"]),
              detail: chatText(o["detail"], 2100),
            };
          }),
        };
      }),
    },
    activity: array(raw["activity"], 32, (value) => {
      const a = chatObject(value);
      return {
        id: chatText(a["id"]),
        label: chatText(a["label"], 2100),
        detail: chatText(a["detail"], 2100),
      };
    }),
  };
}
export function parseChatPage(
  value: unknown,
  taskId: number,
  sessionId: number,
): SessionChatPage {
  const raw = chatObject(value);
  if (raw["taskId"] !== taskId || raw["sessionId"] !== sessionId)
    throw invalid();
  return {
    taskId,
    sessionId,
    cursor: chatText(raw["cursor"], 200),
    reset: bool(raw["reset"]),
    before: nullable(raw["before"]),
    state: state(raw["state"]),
    items: array(raw["items"], 80, item),
    events: array(raw["events"], 80, (value): SessionChatEvent => {
      const event = chatObject(value);
      if (event["type"] === "reset") return { type: "reset" };
      if (event["type"] === "item")
        return { type: "item", item: item(event["item"]) };
      if (event["type"] === "delta")
        return {
          type: "delta",
          id: chatText(event["id"]),
          text: chatText(event["text"], 16100),
        };
      throw invalid();
    }),
  };
}
export function parseChatAction(value: unknown): SessionChatAction {
  const raw = chatObject(value),
    type = raw["type"];
  switch (type) {
    case "provider": {
      const provider = chatText(raw["provider"]),
        expectedProvider = chatText(raw["expectedProvider"]);
      if (!provider.trim() || !expectedProvider.trim()) throw invalid();
      return { type, provider, expectedProvider };
    }
    case "send": {
      const text = chatText(raw["text"], 64000);
      if (!text.trim()) throw invalid();
      return { type, text, queue: bool(raw["queue"]) };
    }
    case "stop":
    case "resume-queue":
      return { type };
    case "cancel-queued":
    case "steer-queued":
      return { type, id: chatText(raw["id"]) };
    case "permission": {
      const decision = raw["decision"];
      if (
        decision !== "approved" &&
        decision !== "always" &&
        decision !== "denied"
      )
        throw invalid();
      return { type, id: chatText(raw["id"]), decision };
    }
    case "answer": {
      const answers = chatObject(raw["answers"]);
      if (Object.keys(answers).length > 20) throw invalid();
      return {
        type,
        id: chatText(raw["id"]),
        ...(raw["decline"] === undefined
          ? {}
          : { decline: bool(raw["decline"]) }),
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, value]) => [
            chatText(key),
            array(value, 30, (v) => chatText(v, 4000)),
          ]),
        ),
      };
    }
    case "model":
      return { type, model: nullable(raw["model"]) };
    case "plan":
      return { type, enabled: bool(raw["enabled"]) };
    case "permission-mode":
      return { type, mode: chatText(raw["mode"]) };
    default:
      throw invalid();
  }
}
