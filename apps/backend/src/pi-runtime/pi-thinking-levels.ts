/** Mirrors Pi's model metadata rules without depending on its CLI's npm package.
 * https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.ts
 * Missing mappings use Pi's defaults through high; null disables a level.
 * xhigh/max require explicit mappings, so new levels are never guessed by model ID.
 */
export function piThinkingLevels(model: Record<string, unknown>): string[] {
  if (model.reasoning !== true) return [];
  const map = model.thinkingLevelMap;
  const mappings =
    map && typeof map === 'object' && !Array.isArray(map)
      ? (map as Record<string, unknown>)
      : {};
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(
    (level) => {
      const mapped = mappings[level];
      if (mapped === null) return false;
      return (
        (level !== 'xhigh' && level !== 'max') || typeof mapped === 'string'
      );
    },
  );
}
