import type {
  BrowserElement,
  TaskBrowserState,
  TaskBrowserTab,
} from "@elevenex/shared";
import { browserId, browserUrl, record } from "./validation";
function invalid(): never {
  throw new Error("Incompatible remote browser state");
}
function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) invalid();
  return value;
}
function element(value: unknown): BrowserElement {
  const raw = record(value);
  const selector = text(raw["selector"], 2048),
    tag = text(raw["tag"], 40);
  if (
    !/^html(?: > (?:[a-z][a-z0-9-]{0,40}|\*):nth-child\([1-9][0-9]*\)){1,20}$/.test(
      selector,
    ) ||
    !/[a-z]/.test(tag)
  )
    invalid();
  const coordinates = ["x", "y", "width", "height"].map((key) => {
    const n = raw[key];
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1000000)
      invalid();
    return n;
  });
  return {
    selector,
    tag,
    x: coordinates[0]!,
    y: coordinates[1]!,
    width: coordinates[2]!,
    height: coordinates[3]!,
  };
}
function tab(value: unknown): TaskBrowserTab {
  const raw = record(value);
  const id = browserId(raw["id"]),
    url = text(raw["url"], 2048);
  if (url) browserUrl(url);
  const by = raw["by"],
    driver = raw["driver"],
    width = raw["width"],
    theme = raw["theme"];
  if (
    (by !== "you" && by !== "agent") ||
    (driver !== "you" && driver !== "agent" && driver !== "needs") ||
    (width !== "full" && width !== "phone") ||
    (theme !== "system" && theme !== "light" && theme !== "dark")
  )
    invalid();
  const session =
    raw["agentSessionId"] === null ? null : integer(raw["agentSessionId"], 1);
  const step = raw["step"] === undefined ? undefined : record(raw["step"]);
  return {
    id,
    url,
    by,
    driver,
    width,
    theme,
    agentSessionId: session,
    title: text(raw["title"], 200),
    generation: integer(raw["generation"], 1),
    loading: boolean(raw["loading"]),
    ready: boolean(raw["ready"]),
    canGoBack: boolean(raw["canGoBack"]),
    canGoForward: raw["canGoForward"] === undefined ? false : boolean(raw["canGoForward"]),
    error: raw["error"] === null ? null : text(raw["error"], 400),
    errors: integer(raw["errors"], 0, 999),
    slowNetwork: boolean(raw["slowNetwork"]),
    waiting: boolean(raw["waiting"]),
    ...(raw["server"] === undefined ? {} : { server: text(raw["server"], 80) }),
    ...(step
      ? {
          step: {
            n: integer(step["n"], 1, 10000),
            text: text(step["text"], 400),
            ...(step["total"] === undefined
              ? {}
              : { total: integer(step["total"], 1, 10000) }),
          },
        }
      : {}),
    ...(raw["target"] === undefined ? {} : { target: element(raw["target"]) }),
  };
}
/** Runtime replies are allowlisted before entering the trusted window's UI state. */
export function remoteBrowserState(
  value: unknown,
  scopeId: string,
  taskId: number,
): TaskBrowserState {
  const raw = record(value);
  if (
    raw["taskId"] !== taskId ||
    !Array.isArray(raw["tabs"]) ||
    raw["tabs"].length > 12 ||
    raw["privacy"] !== "content-withheld"
  )
    invalid();
  const tabs = raw["tabs"].map(tab);
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) invalid();
  const active = raw["active"] === null ? null : browserId(raw["active"]);
  if (active && !tabs.some((tab) => tab.id === active)) invalid();
  if (!Array.isArray(raw["ports"]) || raw["ports"].length > 32) invalid();
  const attention =
    raw["attention"] === undefined ? undefined : record(raw["attention"]);
  if (
    attention &&
    !["popup", "dialog", "file-picker", "download"].includes(
      String(attention["kind"]),
    )
  )
    invalid();
  return {
    canDetach: raw['canDetach'] === true,
    canReorder: raw['canReorder'] === true,
    ...(raw['streamVersion'] === 1 ? { streamVersion: 1 as const } : {}),
    ...(raw['videoStream'] === 'h264' ? { videoStream: 'h264' as const } : {}),
    ...(raw['videoWindow'] === 8 ? { videoWindow: 8 as const } : {}),
    ...(raw['layoutLanes'] === true ? { layoutLanes: true } : {}),
    scopeId,
    taskId,
    revision: integer(raw["revision"]),
    surfaceEpoch: integer(raw["surfaceEpoch"]),
    controlsFocus: integer(raw["controlsFocus"]),
    active,
    tabs,
    picked: raw["picked"] === null ? null : element(raw["picked"]),
    picking: boolean(raw["picking"]),
    pickerMessage:
      raw["pickerMessage"] === null ? null : text(raw["pickerMessage"], 400),
    feedback: boolean(raw["feedback"]),
    ports: raw["ports"].map((port) => integer(port, 1, 65535)),
    privacy: "content-withheld",
    ...(attention
      ? {
          attention: {
            kind: attention["kind"] as NonNullable<
              TaskBrowserState["attention"]
            >["kind"],
            message: text(attention["message"], 400),
            outside: boolean(attention["outside"]),
            ...(attention["tabId"] === undefined ? {} : {tabId: browserId(attention["tabId"])}),
          },
        }
      : {}),
  };
}
