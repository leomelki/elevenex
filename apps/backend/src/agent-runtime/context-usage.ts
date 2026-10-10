/** Context occupancy, never cumulative billing usage. Unknown limits stay unknown. */
export function contextPercentage(
  tokens: number,
  window: number,
): number | null {
  if (
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    !Number.isFinite(window) ||
    window <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.round((tokens / window) * 100));
}
