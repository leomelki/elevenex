import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';

/** Only explicit human decisions qualify; a failed tool is not a user denial. */
export function isToolDenied(call: ClaudeTranscriptItem): boolean {
  return call.interaction?.decision === 'denied' || call.interaction?.decision === 'declined';
}

export function toolDenialReason(call: ClaudeTranscriptItem): string {
  if (!isToolDenied(call)) return '';
  const message = call.interaction?.content?.['message'];
  return typeof message === 'string' ? message.trim() : '';
}

export function toolDenialBatch(call: ClaudeTranscriptItem): Array<{ toolUseId: string }> {
  const batch = call.interaction?.requestSnapshot?.['batch'];
  return Array.isArray(batch)
    ? batch.filter((item): item is { toolUseId: string } => typeof item?.toolUseId === 'string')
    : [];
}
