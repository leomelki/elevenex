import { fileURLToPath } from 'node:url';

export function codexImageViewInput(value: unknown): { path: string } {
  if (typeof value !== 'string') return { path: '' };
  if (!value.startsWith('file:')) return { path: value };
  try {
    return { path: fileURLToPath(value) };
  } catch {
    return { path: value };
  }
}

export function codexImageViewResult(path: string) {
  // The chat media reader enforces the task's path and file-type policy.
  return { content: path ? [{ type: 'image', image_url: path }] : [] };
}

/** The app-server exposes native generation separately from MCP tool calls.
 * Prefer its saved path; older releases provide PNG bytes directly. */
export function codexImageResult(item: Record<string, unknown>) {
  const saved = item.savedPath ?? item.saved_path;
  const result = item.result;
  const source =
    typeof saved === 'string'
      ? saved
      : typeof result === 'string' && result
        ? result.startsWith('data:')
          ? result
          : `data:image/png;base64,${result}`
        : undefined;
  return {
    content: source ? [{ type: 'image', image_url: source }] : [],
    ...(item.failure ? { error: item.failure } : {}),
  };
}
