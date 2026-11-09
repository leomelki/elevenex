import type {
  BrowserCodeCommand,
  BrowserCodeResult,
  BrowserCodeImage,
} from "@elevenex/shared";
import { integer, object } from "./host.js";

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unexpected browser code field");
}
export function browserCodeCommand(value: unknown): BrowserCodeCommand {
  const input = object(value);
  exact(input, ["kind", "code", "timeoutMs", "reset"]);
  if (
    input["kind"] !== "code" ||
    typeof input["code"] !== "string" ||
    input["code"].length > 65536 ||
    (input["reset"] !== undefined && typeof input["reset"] !== "boolean")
  )
    throw new Error("Invalid browser code request");
  return {
    kind: "code",
    code: input["code"],
    timeoutMs: integer(input["timeoutMs"], 15000, 250, 60000),
    ...(input["reset"] === true ? { reset: true } : {}),
  };
}
export function browserCodeResult(value: unknown): BrowserCodeResult {
  const input = object(value);
  exact(input, ["sandboxId", "value", "logs", "images", "error"]);
  if (
    typeof input["sandboxId"] !== "string" ||
    input["sandboxId"].length > 36 ||
    !Array.isArray(input["logs"]) ||
    input["logs"].length > 100 ||
    input["logs"].some((log) => typeof log !== "string") ||
    input["logs"].join("").length > 32000 ||
    !Array.isArray(input["images"]) ||
    input["images"].length > 4 ||
    Buffer.byteLength(JSON.stringify(input["value"] ?? null)) > 1048576
  )
    throw new Error("Invalid browser code result");
  const images: BrowserCodeImage[] = input["images"].map((raw: unknown) => {
    const image = object(raw);
    exact(image, ["data", "mimeType", "width", "height"]);
    if (
      typeof image["data"] !== "string" ||
      image["data"].length > 2796204 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(image["data"]) ||
      !["image/jpeg", "image/png"].includes(String(image["mimeType"]))
    )
      throw new Error("Invalid browser image");
    return {
      data: image["data"],
      mimeType: image["mimeType"] as BrowserCodeImage["mimeType"],
      width: integer(image["width"], 0, 1, 4096),
      height: integer(image["height"], 0, 1, 4096),
    };
  });
  let error: BrowserCodeResult["error"];
  if (input["error"] !== undefined) {
    const detail = object(input["error"]);
    exact(detail, ["message", "outcomeUnknown"]);
    if (
      typeof detail["message"] !== "string" ||
      detail["message"].length > 4096 ||
      typeof detail["outcomeUnknown"] !== "boolean"
    )
      throw new Error("Invalid browser error");
    error = {
      message: detail["message"],
      outcomeUnknown: detail["outcomeUnknown"],
    };
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 12500000)
    throw new Error("Browser reply exceeded transport limit");
  return {
    sandboxId: input["sandboxId"],
    value: input["value"] ?? null,
    logs: input["logs"] as string[],
    images,
    ...(error ? { error } : {}),
  };
}
