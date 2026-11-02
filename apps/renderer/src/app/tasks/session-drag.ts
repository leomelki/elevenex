import type { TaskSession } from './task.models';

/** Renderer-only transfer contract. No transcript, filesystem path or platform handle. */
export const SESSION_DRAG_TYPE = 'application/x-elevenex-desktop-session';
export interface SessionDragReference {
  readonly id: string;
  readonly title: string;
  readonly scopeId?: string;
}

export function writeSessionDrag(transfer: DataTransfer, session: TaskSession): void {
  const reference: SessionDragReference = {
    id: session.id, title: session.title,
    ...(session.mentionScope ? { scopeId: session.mentionScope } : {}),
  };
  transfer.effectAllowed = 'copy';
  transfer.setData(SESSION_DRAG_TYPE, JSON.stringify(reference));
}

/** Drag data is untrusted, including when another window supplies our MIME type. */
export function readSessionDrag(transfer: DataTransfer, scopeId?: string): SessionDragReference | null {
  const text = transfer.getData(SESSION_DRAG_TYPE);
  if (!text || text.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !('id' in value) || !('title' in value)) return null;
    if (typeof value.id !== 'string' || !value.id || value.id.length > 100 ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 1000 || Array.from(value.title).some(character => character.charCodeAt(0) < 32)) return null;
    const scope = 'scopeId' in value ? value.scopeId : undefined;
    if ((scope !== undefined && (typeof scope !== 'string' || scope.length > 1000)) || scope !== scopeId) return null;
    if (scopeId && (!/^[1-9]\d*$/.test(value.id) || !Number.isSafeInteger(Number(value.id)))) return null;
    return { id: value.id, title: value.title, ...(scopeId ? { scopeId } : {}) };
  } catch { return null; }
}
