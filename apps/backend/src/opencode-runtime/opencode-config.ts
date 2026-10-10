/** Overlay owned settings without dropping unrelated user-provided inline configuration. */
export function mergeOpenCodeConfig(
  inherited: string | undefined,
  overrides: object,
): string {
  const merge = (base: unknown, overlay: unknown): unknown => {
    if (
      !base ||
      typeof base !== 'object' ||
      Array.isArray(base) ||
      !overlay ||
      typeof overlay !== 'object' ||
      Array.isArray(overlay)
    )
      return overlay;
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay))
      result[key] = merge(result[key], value);
    return result;
  };
  // Preserve invalid-config diagnostics instead of silently discarding the user's input.
  const base: unknown = inherited?.trim() ? JSON.parse(inherited) : {};
  return JSON.stringify(merge(base, overrides));
}
