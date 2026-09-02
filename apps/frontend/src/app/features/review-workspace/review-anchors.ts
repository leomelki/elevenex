import type { ChangeReviewRow } from '@/shared/models/change-review.model';
import type {
  ReviewAnchor,
  ReviewAnchorState,
  ReviewChat,
} from '@/shared/models/review-chat.model';
import { diffMentionRowKey } from '@/shared/utils/diff-row-key';

/** Current identity of a file as rendered in the diff viewer. */
export interface FileIdentity {
  changeHash: string | null;
  fingerprint: string | null;
}

/**
 * How a stored anchor relates to the code as it stands now.
 *
 * - `exact`   the file is byte-identical to when the discussion started.
 * - `moved`   the file changed but the diff rows still match, so the selection
 *             is still locatable by content.
 * - `drifted` neither matches; the selection can no longer be trusted to point
 *             at the same code.
 */
export function resolveAnchorState(
  anchor: Pick<ReviewAnchor, 'changeHash'>,
  storedFingerprint: string | null,
  current: FileIdentity | null,
): ReviewAnchorState {
  if (!current) return 'drifted';
  if (storedFingerprint && current.fingerprint === storedFingerprint) {
    return 'exact';
  }
  if (anchor.changeHash && current.changeHash === anchor.changeHash) {
    return 'moved';
  }
  return 'drifted';
}

export function reviewChatAnchorState(
  chat: ReviewChat,
  current: FileIdentity | null,
): ReviewAnchorState {
  const primary = chat.anchors[0];
  if (!primary) return 'drifted';
  return resolveAnchorState(primary, chat.fingerprint, current);
}

/**
 * Map every diff row an open discussion is anchored to onto the discussions
 * that reference it, so the diff viewer can render inline markers.
 *
 * Keyed exactly like the panel's existing "mentioned row" highlighting, which
 * means a line that shifted but kept its text still lights up.
 */
export function buildAnchorRowIndex(
  chats: readonly ReviewChat[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const chat of chats) {
    if (chat.status === 'resolved') continue;
    for (const anchor of chat.anchors) {
      for (const row of anchor.context?.selected ?? []) {
        const key = diffMentionRowKey(
          anchor.scope,
          anchor.filePath,
          anchor.changeHash,
          row.type,
          row.oldLine,
          row.newLine,
          row.content,
        );
        const existing = index.get(key);
        if (existing) {
          if (!existing.includes(chat.id)) existing.push(chat.id);
        } else {
          index.set(key, [chat.id]);
        }
      }
    }
  }
  return index;
}

/**
 * Best-effort relocation of a drifted anchor by matching its selected text
 * against the rows currently loaded for that file.
 *
 * Returns the new starting row index only when the match is unambiguous —
 * silently moving an anchor to one of several candidates would point the
 * discussion at the wrong code, which is worse than showing it as stale.
 */
export function relocateAnchor(
  anchor: ReviewAnchor,
  rows: readonly ChangeReviewRow[],
): number | null {
  const needle = (anchor.context?.selected ?? []).map((row) => row.content);
  if (!needle.length || needle.length > rows.length) return null;

  let found: number | null = null;
  for (let start = 0; start <= rows.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (rows[start + offset].content !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (found !== null) return null; // ambiguous
    found = start;
  }
  return found;
}

/** Short human label for an anchor, e.g. `foo.ts:12-18`. */
export function anchorLabel(anchor: ReviewAnchor): string {
  const basename = anchor.filePath.split('/').pop() ?? anchor.filePath;
  const start = anchor.newLineStart ?? anchor.oldLineStart;
  const end = anchor.newLineEnd ?? anchor.oldLineEnd;
  if (start === null || start === undefined) return basename;
  return end && end !== start
    ? `${basename}:${start}-${end}`
    : `${basename}:${start}`;
}
