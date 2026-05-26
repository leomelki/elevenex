import type {
  DiffSelectionMention,
  DiffSelectionMentionContextRow,
} from '@/shared/models/diff-selection-mention.model';
import type {
  ChangeReviewFileStatus,
  ChangeReviewRowType,
  ChangeReviewScope,
} from '@/shared/models/change-review.model';

export const DIFF_SELECTION_MENTION_TAG = 'elevenex_git_diff_selection_mention';

const DIFF_SELECTION_MENTION_PATTERN = new RegExp(
  `<${DIFF_SELECTION_MENTION_TAG}>([\\s\\S]*?)</${DIFF_SELECTION_MENTION_TAG}>`,
  'g',
);

const ROW_TYPES: ReadonlySet<ChangeReviewRowType> = new Set<ChangeReviewRowType>([
  'hunk',
  'context',
  'add',
  'delete',
  'expand',
  'meta',
]);

const SCOPES: ReadonlySet<ChangeReviewScope> = new Set<ChangeReviewScope>([
  'uncommitted',
  'last-commit',
  'branch',
]);

const STATUSES: ReadonlySet<ChangeReviewFileStatus> = new Set<ChangeReviewFileStatus>([
  'added',
  'modified',
  'deleted',
  'renamed',
]);

export interface ParsedDiffSelectionMentions {
  text: string;
  mentions: DiffSelectionMention[];
}

export function appendDiffSelectionMentions(
  text: string,
  mentions: readonly DiffSelectionMention[],
): string {
  const blocks = mentions.map((mention) => serializeDiffSelectionMention(mention));
  return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
}

export function serializeDiffSelectionMention(mention: DiffSelectionMention): string {
  return `<${DIFF_SELECTION_MENTION_TAG}>${JSON.stringify(mention)}</${DIFF_SELECTION_MENTION_TAG}>`;
}

export function parseDiffSelectionMentions(value: string | null | undefined): ParsedDiffSelectionMentions {
  const source = value ?? '';
  const mentions: DiffSelectionMention[] = [];
  const text = source.replace(DIFF_SELECTION_MENTION_PATTERN, (_match, raw: string) => {
    const parsed = parseMentionPayload(raw);
    if (parsed) mentions.push(parsed);
    return '';
  });

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    mentions,
  };
}

export function diffSelectionMentionLineLabel(mention: DiffSelectionMention): string {
  const next = rangeLabel('+', mention.newLineStart, mention.newLineEnd);
  const old = rangeLabel('-', mention.oldLineStart, mention.oldLineEnd);
  return [next, old].filter(Boolean).join(' / ') || 'selected lines';
}

export function diffSelectionMentionPreview(mention: DiffSelectionMention): string {
  const compact = mention.selectedText.trim().replace(/\s+/g, ' ');
  if (!compact) return 'Selected diff text';
  return compact.length > 150 ? `${compact.slice(0, 150)}...` : compact;
}

function rangeLabel(prefix: string, start: number | null, end: number | null): string | null {
  if (start === null || end === null) return null;
  return start === end ? `${prefix}${start}` : `${prefix}${start}-${end}`;
}

function parseMentionPayload(raw: string): DiffSelectionMention | null {
  try {
    const value = JSON.parse(raw);
    return normalizeMention(value);
  } catch {
    return null;
  }
}

function normalizeMention(value: unknown): DiffSelectionMention | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const scope = stringEnum(record['scope'], SCOPES);
  const status = stringEnum(record['status'], STATUSES);
  const filePath = stringValue(record['filePath']);
  const selectedText = stringValue(record['selectedText']);
  if (!scope || !status || !filePath || selectedText === null) return null;

  return {
    id: stringValue(record['id']) || `diff-mention-${Date.now()}`,
    version: 1,
    scope,
    compareLabel: nullableString(record['compareLabel']),
    baseSha: nullableString(record['baseSha']),
    headSha: nullableString(record['headSha']),
    filePath,
    oldPath: nullableString(record['oldPath']),
    status,
    changeHash: nullableString(record['changeHash']),
    oldLineStart: nullableNumber(record['oldLineStart']),
    oldLineEnd: nullableNumber(record['oldLineEnd']),
    newLineStart: nullableNumber(record['newLineStart']),
    newLineEnd: nullableNumber(record['newLineEnd']),
    selectedText,
    context: normalizeContext(record['context']),
    truncated: Boolean(record['truncated']),
  };
}

function normalizeContext(value: unknown): DiffSelectionMention['context'] {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    before: normalizeRows(record['before']),
    selected: normalizeRows(record['selected']),
    after: normalizeRows(record['after']),
  };
}

function normalizeRows(value: unknown): DiffSelectionMentionContextRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => normalizeRow(row))
    .filter((row): row is DiffSelectionMentionContextRow => row !== null)
    .slice(0, 24);
}

function normalizeRow(value: unknown): DiffSelectionMentionContextRow | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = stringEnum(record['type'], ROW_TYPES);
  const content = stringValue(record['content']);
  if (!type || content === null) return null;
  return {
    type,
    oldLine: nullableNumber(record['oldLine']),
    newLine: nullableNumber(record['newLine']),
    content,
  };
}

function stringEnum<T extends string>(value: unknown, options: ReadonlySet<T>): T | null {
  return typeof value === 'string' && options.has(value as T) ? value as T : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
