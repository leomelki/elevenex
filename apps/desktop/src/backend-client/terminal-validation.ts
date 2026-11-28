export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid terminal object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid terminal text");
  return value;
}
export function integer(
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
    throw new Error("Invalid terminal number");
  return value;
}
export function generation(value: unknown): string {
  const id = text(value, 36);
  if (!/^[a-f\d-]{36}$/.test(id))
    throw new Error("Invalid terminal generation");
  return id;
}
export function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key)))
    throw new Error("Unexpected terminal argument");
}
