/** better-sqlite3 errors can cross VM boundaries or be wrapped by Drizzle. */
export function isSqliteUniqueConstraintError(error: unknown): boolean {
  const seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const detail = error as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      detail.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      detail.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      (typeof detail.message === 'string' &&
        detail.message.includes('UNIQUE constraint failed'))
    )
      return true;
    error = detail.cause;
  }
  return false;
}
