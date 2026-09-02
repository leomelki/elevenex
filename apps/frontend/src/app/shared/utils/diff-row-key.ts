import type { ChangeReviewRow } from '@/shared/models/change-review.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';

/**
 * Identity of a single diff row for the purpose of matching a stored selection
 * back onto the rendered diff.
 *
 * The row's **content** is part of the key on purpose: a line that shifted but
 * is textually identical still matches, while `changeHash` scopes the key so a
 * selection taken against an older diff simply stops matching instead of
 * highlighting whatever now occupies those line numbers.
 */
export function diffMentionRowKey(
  scope: DiffSelectionMention['scope'],
  filePath: string,
  changeHash: string | null,
  type: ChangeReviewRow['type'],
  oldLine: number | null,
  newLine: number | null,
  content: string,
): string {
  return JSON.stringify([
    scope,
    filePath,
    changeHash,
    type,
    oldLine,
    newLine,
    content,
  ]);
}
