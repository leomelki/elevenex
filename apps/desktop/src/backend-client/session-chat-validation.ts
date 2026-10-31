import { parseChangeSummary } from "./session-chat-changes";
import type {
  SessionChatAction,
  SessionChatEvent,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
  SessionChatPlanUsage,
  SessionChatPresetDefault,
  SessionChatCatalog,
} from "@elevenex/shared";
import { chatObject, chatText, invalid } from "./session-chat-values";
export { chatObject, chatText } from "./session-chat-values";
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
function presetId(value: unknown): string {
  const id = chatText(value, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw invalid();
  return id;
}
function defaultRevision(value: unknown): string {
  const revision = chatText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw invalid();
  return revision;
}
export function parsePresetDefault(value: unknown): SessionChatPresetDefault {
  const raw = chatObject(value);
  const defaultIds = array(raw["defaultIds"], 24, presetId);
  if (new Set(defaultIds).size !== defaultIds.length) throw invalid();
  const id = raw["id"] === null ? null : presetId(raw["id"]);
  if (id !== null && !defaultIds.includes(id)) throw invalid();
  return {
    id,
    provider: presetId(raw["provider"]),
    defaultIds,
    revision: defaultRevision(raw["revision"]),
  };
}
export function parseChatCatalog(
  value: unknown,
  provider: string,
): SessionChatCatalog {
  const raw = chatObject(value);
  if (raw["provider"] !== provider) throw invalid();
  const models = array(raw["models"], 100, (value) => {
    const model = chatObject(value);
    return {
      id: chatText(model["id"], 200),
      label: chatText(model["label"], 200),
      reasoningEfforts: array(model["reasoningEfforts"], 20, (v) =>
        chatText(v, 100),
      ),
      supportsFastMode: bool(model["supportsFastMode"]),
    };
  });
  if (new Set(models.map((m) => m.id)).size !== models.length) throw invalid();
  const selected = nullable(raw["model"], 200);
  const reasoning = nullable(raw["reasoning"], 100);
  const model = models.find((m) => m.id === selected);
  const fast = bool(raw["fast"]);
  if (
    (selected !== null && !model) ||
    (reasoning !== null && !model?.reasoningEfforts.includes(reasoning)) ||
    (fast && !model?.supportsFastMode)
  )
    throw invalid();
  return {
    provider,
    label: chatText(raw["label"], 200),
    models,
    model: selected,
    reasoning,
    fast,
    reasoningAvailable: bool(raw["reasoningAvailable"]),
    fastAvailable: bool(raw["fastAvailable"]),
    error: nullable(raw["error"], 1000),
  };
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
    ...(raw["changes"] !== undefined ? { changes: parseChangeSummary(raw["changes"]) } : {}),
  };
}
function planUsage(
  value: unknown,
  provider: unknown,
): SessionChatPlanUsage | null {
  if (value === null) return null;
  const raw = chatObject(value);
  const source = raw["provider"],
    status = raw["status"];
  if (
    (source !== "codex" && source !== "claude") ||
    source !== provider ||
    (status !== "available" && status !== "warning" && status !== "exhausted")
  )
    throw invalid();
  const updatedAt = chatText(raw["updatedAt"], 100);
  if (!Number.isFinite(Date.parse(updatedAt))) throw invalid();
  const windows = array(raw["windows"], 8, (value) => {
    const window = chatObject(value);
    const id = chatText(window["id"], 100),
      label = chatText(window["label"], 100);
    if (!id || !label) throw invalid();
    return {
      id,
      label,
      remainingPercentage: number(window["remainingPercentage"], 100),
      resetsAt:
        window["resetsAt"] === null
          ? null
          : number(window["resetsAt"], 8.64e12),
    };
  });
  if (
    !windows.length ||
    new Set(windows.map((window) => window.id)).size !== windows.length
  )
    throw invalid();
  return {
    provider: source,
    planName: nullable(raw["planName"], 100),
    status,
    windows,
    updatedAt,
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
  if (raw["presets"] !== undefined) {
    const presets = array(raw["presets"], 24, (value) =>
      presetId(chatObject(value)["id"]),
    );
    if (new Set(presets).size !== presets.length) throw invalid();
  }
  const context = raw["context"] === null ? null : chatObject(raw["context"]);
  return {
    provider: chatText(raw["provider"]),
    ...(raw["presetCatalogs"] === undefined
      ? {}
      : { presetCatalogs: bool(raw["presetCatalogs"]) }),
    ...(raw["presetDefault"] === undefined
      ? {}
      : { presetDefault: parsePresetDefault(raw["presetDefault"]) }),
    ...(raw["presets"] === undefined
      ? {}
      : {
          presets: array(raw["presets"], 24, (value) => {
            const preset = chatObject(value);
            return {
              id: presetId(preset["id"]),
              name: chatText(preset["name"], 48),
              provider: chatText(preset["provider"]),
              providerLabel: chatText(preset["providerLabel"]),
              model: nullable(preset["model"]),
              modelLabel: chatText(preset["modelLabel"]),
              reasoning: nullable(preset["reasoning"]),
              fast: bool(preset["fast"]),
            };
          }),
        }),
    ...(raw["planUsage"] === undefined
      ? {}
      : {
          planUsage: planUsage(raw["planUsage"], raw["provider"]),
        }),
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
    ...(raw["controls"] === undefined
      ? {}
      : {
          controls: {
            plan: bool(chatObject(raw["controls"])["plan"]),
            reasoning: bool(chatObject(raw["controls"])["reasoning"]),
            fast: bool(chatObject(raw["controls"])["fast"]),
          },
        }),
    ...(raw["fast"] === undefined ? {} : { fast: bool(raw["fast"]) }),
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
      return {
        id: chatText(m["id"]),
        label: chatText(m["label"]),
        ...(m["reasoningEfforts"] === undefined
          ? {}
          : {
              reasoningEfforts: array(m["reasoningEfforts"], 20, (v) =>
                chatText(v),
              ),
            }),
        ...(m["supportsFastMode"] === undefined
          ? {}
          : { supportsFastMode: bool(m["supportsFastMode"]) }),
      };
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
    case "preset-default":
      return {
        type,
        id: presetId(raw["id"]),
        expectedProvider: presetId(raw["expectedProvider"]),
        expectedRevision: defaultRevision(raw["expectedRevision"]),
      };
    case "preset-default-restore": {
      const defaultIds = array(raw["defaultIds"], 24, presetId);
      if (new Set(defaultIds).size !== defaultIds.length) throw invalid();
      return {
        type,
        provider: presetId(raw["provider"]),
        defaultIds,
        expectedRevision: defaultRevision(raw["expectedRevision"]),
      };
    }
    case "preset":
      return {
        type,
        id: presetId(raw["id"]),
        expectedProvider: chatText(raw["expectedProvider"]),
      };
    case "save-preset": {
      const name = chatText(raw["name"], 48).trim();
      if (
        !name ||
        (raw["makeDefault"] === true &&
          raw["expectedDefaultRevision"] === undefined)
      )
        throw invalid();
      return {
        type,
        id: presetId(raw["id"]),
        name,
        ...(raw["provider"] === undefined
          ? {}
          : { provider: presetId(raw["provider"]) }),
        ...(raw["makeDefault"] === undefined
          ? {}
          : { makeDefault: bool(raw["makeDefault"]) }),
        ...(raw["expectedDefaultRevision"] === undefined
          ? {}
          : {
              expectedDefaultRevision: defaultRevision(
                raw["expectedDefaultRevision"],
              ),
            }),
        expectedProvider: chatText(raw["expectedProvider"]),
        model: nullable(raw["model"]),
        reasoning: nullable(raw["reasoning"]),
        fast: bool(raw["fast"]),
      };
    }
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
    case "fast":
      return { type, enabled: bool(raw["enabled"]) };
    case "reasoning":
      return { type, effort: nullable(raw["effort"]) };
    case "permission-mode":
      return { type, mode: chatText(raw["mode"]) };
    default:
      throw invalid();
  }
}
