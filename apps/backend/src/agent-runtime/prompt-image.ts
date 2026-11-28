import type { AgentImageInput } from './agent-runtime.types.js';

export function savedPromptImage(mediaType: unknown, data: unknown): AgentImageInput | undefined {
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' &&
      mediaType !== 'image/gif' && mediaType !== 'image/webp') return;
  if (typeof data !== 'string' || !data) return;
  return { mediaType, data };
}

export function savedPromptImageUrl(value: unknown): AgentImageInput | undefined {
  if (typeof value !== 'string' || !value.startsWith('data:')) return;
  const comma = value.indexOf(',');
  if (comma < 0 || !value.slice(0, comma).endsWith(';base64')) return;
  return savedPromptImage(value.slice(5, comma - 7), value.slice(comma + 1));
}
