import type { SessionChatRecord, SessionChatTurnTimelineRow } from '@elevenex/shared';

/** Keep the transcript's existing chronological projection and tool controls. A
 * saved tool's evidence uses the shared turn revision until it is inspected. */
export function timelineRecord(row: NonNullable<SessionChatTurnTimelineRow>, revision: string): SessionChatRecord {
  if ('timestamp' in row) return row;
  const base = { id: row.id, text: '', timestamp: '', toolName: null, toolKind: null, input: '', error: false, truncated: false };
  if (row.kind === 'media') return { ...base, kind: 'tool_result', toolId: row.callId, media: row.media };
  return {
    ...base,
    kind: row.kind === 'call' ? 'tool_use' : 'tool_result',
    toolId: row.agent?.toolId ?? (row.kind === 'call' ? row.id : null),
    toolName: row.label,
    toolKind: row.toolKind,
    error: row.error === true,
    toolDetails: { revision, summary: row.label, ...(row.meta ? { meta: row.meta } : {}) },
    ...(row.media ? { media: row.media } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.resultId ? { receipt: { id: row.resultId, error: row.error === true, toolDetails: { revision } } } : {}),
  };
}
