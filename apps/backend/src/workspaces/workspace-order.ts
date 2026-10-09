/** Unordered records use their creation ID, so new tasks append automatically. */
export function compareWorkspaceOrder(
  a: { id: number; isDefault: boolean; sortOrder?: number | null },
  b: { id: number; isDefault: boolean; sortOrder?: number | null },
): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  const position = (item: typeof a) =>
    item.sortOrder ?? (item.id > 0 ? item.id : Number.MAX_SAFE_INTEGER);
  return position(a) - position(b) || a.id - b.id;
}
