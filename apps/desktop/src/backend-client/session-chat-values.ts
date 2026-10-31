import { BackendRequestError } from "./transport";
export const invalid = () =>
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
