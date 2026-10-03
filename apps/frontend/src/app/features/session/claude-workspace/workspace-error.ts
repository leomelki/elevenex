export function getHttpErrorMessage(error: unknown, fallback: string): string {
  return (
    (error as { error?: { message?: string } })?.error?.message ||
    (error instanceof Error ? error.message : null) ||
    fallback
  );
}
