import type {
  DiffSelectionMention,
  DiffSelectionMentionContextRow,
  DiffSelectionMentionScope,
  DiffSelectionMentionStatus,
} from '@/shared/models/diff-selection-mention.model';
import type { ChangeReviewRowType } from '@/shared/models/change-review.model';

export const DIFF_SELECTION_MENTION_TAG = 'elevenex_git_diff_selection_mention';

const CONTEXT_ROW_MAX_CHARS = 300;
const FILE_LABEL = 'File';
const LINES_LABEL = 'Lines';
const STATUS_LABEL = 'Status';
const TRUNCATED_LABEL = 'Truncated';
const CONTEXT_BEFORE_LABEL = 'Context before';
const CONTEXT_AFTER_LABEL = 'Context after';
const SELECTED_TEXT_LABEL = 'Selected text';

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

const SCOPES: ReadonlySet<DiffSelectionMentionScope> = new Set<DiffSelectionMentionScope>([
  'uncommitted',
  'last-commit',
  'branch',
  'conflicts',
]);

const STATUSES: ReadonlySet<DiffSelectionMentionStatus> = new Set<DiffSelectionMentionStatus>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'conflicted',
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
  const lines = [
    `${FILE_LABEL}: ${mention.filePath}`,
    `${LINES_LABEL}: ${diffSelectionMentionLineLabel(mention)}`,
    `${STATUS_LABEL}: ${mention.status}`,
  ];
  if (mention.truncated) {
    lines.push(`${TRUNCATED_LABEL}: yes`);
  }

  const before = mention.context.before.map(formatContextRow);
  if (before.length) {
    lines.push(`${CONTEXT_BEFORE_LABEL}:`, ...before);
  }

  const after = mention.context.after.map(formatContextRow);
  if (after.length) {
    lines.push(`${CONTEXT_AFTER_LABEL}:`, ...after);
  }

  lines.push(`${SELECTED_TEXT_LABEL}:`, mention.selectedText.trim());
  const payload = escapeMentionPayload(lines.join('\n'));
  return `<${DIFF_SELECTION_MENTION_TAG}>\n${payload}\n</${DIFF_SELECTION_MENTION_TAG}>`;
}

export function parseDiffSelectionMentions(
  value: string | null | undefined,
): ParsedDiffSelectionMentions {
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
  const value = unescapeMentionPayload(raw).trim();
  if (!value) return null;

  const plaintext = parsePlaintextMention(value);
  if (plaintext) return plaintext;

  try {
    return normalizeMention(JSON.parse(value));
  } catch {
    return null;
  }
}

function parsePlaintextMention(value: string): DiffSelectionMention | null {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const selectedIndex = headerIndex(lines, SELECTED_TEXT_LABEL);
  const metadataLines = selectedIndex === -1 ? lines : lines.slice(0, selectedIndex);
  const filePath = fieldValue(metadataLines, FILE_LABEL);
  if (!filePath || selectedIndex === -1) return null;

  const selectedText = lines
    .slice(selectedIndex + 1)
    .join('\n')
    .trim();
  if (!selectedText) return null;

  const status = stringEnum(fieldValue(metadataLines, STATUS_LABEL), STATUSES) ?? 'modified';
  const lineLabel = fieldValue(metadataLines, LINES_LABEL);
  const ranges = parseLineRanges(lineLabel);

  return {
    id: stableMentionId(filePath, lineLabel, selectedText),
    version: 1,
    scope: status === 'conflicted' ? 'conflicts' : 'branch',
    compareLabel: null,
    baseSha: null,
    headSha: null,
    filePath,
    oldPath: null,
    status,
    changeHash: null,
    oldLineStart: ranges.old.start,
    oldLineEnd: ranges.old.end,
    newLineStart: ranges.new.start,
    newLineEnd: ranges.new.end,
    selectedText,
    context: {
      before: parseContextRows(
        sectionLines(lines, CONTEXT_BEFORE_LABEL, [CONTEXT_AFTER_LABEL, SELECTED_TEXT_LABEL]),
      ),
      selected: [],
      after: parseContextRows(sectionLines(lines, CONTEXT_AFTER_LABEL, [SELECTED_TEXT_LABEL])),
    },
    truncated: fieldValue(metadataLines, TRUNCATED_LABEL)?.toLowerCase() === 'yes',
  };
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
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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
  return typeof value === 'string' && options.has(value as T) ? (value as T) : null;
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

function formatContextRow(row: DiffSelectionMentionContextRow): string {
  const content = truncateLine(row.content.trimEnd());
  if (row.type === 'hunk') return `@@: ${content}`;
  if (row.type === 'add') return `+${row.newLine ?? '?'}: ${content}`;
  if (row.type === 'delete') return `-${row.oldLine ?? '?'}: ${content}`;
  const line = row.newLine ?? row.oldLine;
  return line === null ? content : `${line}: ${content}`;
}

function truncateLine(value: string): string {
  return value.length > CONTEXT_ROW_MAX_CHARS
    ? `${value.slice(0, CONTEXT_ROW_MAX_CHARS)}...`
    : value;
}

function escapeMentionPayload(value: string): string {
  return value.split(`</${DIFF_SELECTION_MENTION_TAG}>`).join(`<\\/${DIFF_SELECTION_MENTION_TAG}>`);
}

function unescapeMentionPayload(value: string): string {
  return value.split(`<\\/${DIFF_SELECTION_MENTION_TAG}>`).join(`</${DIFF_SELECTION_MENTION_TAG}>`);
}

function fieldValue(lines: readonly string[], label: string): string | null {
  const prefix = `${label}:`;
  const line = lines.find((item) => item.startsWith(prefix));
  if (!line) return null;
  return line.slice(prefix.length).trim() || null;
}

function headerIndex(lines: readonly string[], label: string): number {
  const prefix = `${label}:`;
  return lines.findIndex((line) => line.trim() === prefix);
}

function sectionLines(
  lines: readonly string[],
  label: string,
  stopLabels: readonly string[],
): string[] {
  const start = headerIndex(lines, label);
  if (start === -1) return [];
  const stopIndexes = stopLabels
    .map((stopLabel) => headerIndex(lines, stopLabel))
    .filter((index) => index > start);
  const end = stopIndexes.length ? Math.min(...stopIndexes) : lines.length;
  return lines.slice(start + 1, end).filter((line) => line.trim());
}

function parseContextRows(lines: readonly string[]): DiffSelectionMentionContextRow[] {
  return lines.map(parseContextRow);
}

function parseContextRow(line: string): DiffSelectionMentionContextRow {
  const trimmed = line.trimEnd();
  const hunk = trimmed.match(/^@@:\s?(.*)$/);
  if (hunk) {
    return {
      type: 'hunk',
      oldLine: null,
      newLine: null,
      content: hunk[1] ?? '',
    };
  }

  const match = trimmed.match(/^([+-]?)(\d+|\?):\s?(.*)$/);
  if (!match) {
    return {
      type: 'context',
      oldLine: null,
      newLine: null,
      content: trimmed,
    };
  }

  const sign = match[1] ?? '';
  const lineNumber = match[2] === '?' ? null : Number(match[2]);
  return {
    type: sign === '+' ? 'add' : sign === '-' ? 'delete' : 'context',
    oldLine: sign === '+' ? null : lineNumber,
    newLine: sign === '-' ? null : lineNumber,
    content: match[3] ?? '',
  };
}

function parseLineRanges(label: string | null): {
  old: { start: number | null; end: number | null };
  new: { start: number | null; end: number | null };
} {
  return {
    old: parseRange(label, '-'),
    new: parseRange(label, '+'),
  };
}

function parseRange(
  label: string | null,
  prefix: '-' | '+',
): {
  start: number | null;
  end: number | null;
} {
  if (!label) return { start: null, end: null };
  const escaped = prefix === '+' ? '\\+' : '-';
  const match = label.match(new RegExp(`(?:^|[\\s/])${escaped}(\\d+)(?:-(\\d+))?`));
  if (!match) return { start: null, end: null };
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return {
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
  };
}

function stableMentionId(filePath: string, lineLabel: string | null, selectedText: string): string {
  return `diff-mention-${hashString(`${filePath}\n${lineLabel ?? ''}\n${selectedText}`)}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
