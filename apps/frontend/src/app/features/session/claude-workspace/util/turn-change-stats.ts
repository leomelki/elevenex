import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { PairedTranscriptUnit } from './paired-transcript';

export interface TurnChangeSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface TurnChangeHunk {
  id: string;
  toolName: string;
  label: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  patch?: string;
  startLine?: number;
}

export interface TurnChangedFile {
  path: string;
  status: 'created' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  hunks: TurnChangeHunk[];
}

export interface TurnChangeDetails extends TurnChangeSummary {
  filesChanged: TurnChangedFile[];
}

interface EditOp {
  oldString: string;
  newString: string;
  label?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  startLine?: number;
}

interface ExtractedEdits {
  filePath: string;
  toolName: string;
  edits: EditOp[];
}

const FILE_WRITING_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'filechanges',
]);

function splitLines(text: string | undefined | null): string[] {
  if (!text) return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split('\n') : [];
}

function lineCount(text: string | undefined | null): number {
  return splitLines(text).length;
}

function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(curr[j - 1], prev[j]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function countLineDiff(oldStr: string, newStr: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);
  if (!oldLines.length) return { additions: newLines.length, deletions: 0 };
  if (!newLines.length) return { additions: 0, deletions: oldLines.length };
  const common = lcsLength(oldLines, newLines);
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[_-]/g, '');
}

function readPath(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return '';
}

function extractEdits(toolName: string, input: unknown): ExtractedEdits[] {
  const record = asRecord(input);
  if (!record) return [];
  const normalized = normalizeToolName(toolName);

  if (normalized === 'edit') {
    const oldString = asString(record['old_string']);
    const newString = asString(record['new_string']);
    const patchEntries = parseApplyPatchLikeEdit(oldString, newString);
    if (patchEntries.length) return patchEntries;

    const filePath = readPath(record, ['file_path', 'filePath', 'path']);
    if (!filePath) return [];
    const startLine = asNumber(record['__startLine']);
    return [{
      filePath,
      toolName,
      edits: [{ oldString, newString, startLine }],
    }];
  }

  if (normalized === 'multiedit') {
    const filePath = readPath(record, ['file_path', 'filePath', 'path']);
    if (!filePath) return [];
    const raw = Array.isArray(record['edits']) ? (record['edits'] as unknown[]) : [];
    const edits: EditOp[] = [];
    for (const [index, entry] of raw.entries()) {
      const editRecord = asRecord(entry);
      if (!editRecord) continue;
      edits.push({
        oldString: asString(editRecord['old_string']),
        newString: asString(editRecord['new_string']),
        label: raw.length > 1 ? `Edit ${index + 1}` : undefined,
        startLine: asNumber(editRecord['__startLine']),
      });
    }
    return edits.length ? [{ filePath, toolName, edits }] : [];
  }

  if (normalized === 'write') {
    const filePath = readPath(record, ['file_path', 'filePath', 'path']);
    if (!filePath) return [];
    return [{
      filePath,
      toolName,
      edits: [{ oldString: '', newString: asString(record['content']) }],
    }];
  }

  if (normalized === 'notebookedit') {
    const filePath = readPath(record, ['notebook_path', 'notebookPath', 'file_path', 'path']);
    if (!filePath) return [];
    return [{
      filePath,
      toolName,
      edits: [{ oldString: '', newString: asString(record['new_source']) }],
    }];
  }

  if (normalized === 'filechanges') {
    const changes = Array.isArray(record['changes']) ? (record['changes'] as unknown[]) : [];
    const extracted: ExtractedEdits[] = [];
    for (const [index, entry] of changes.entries()) {
      const change = asRecord(entry);
      if (!change) continue;
      const filePath = readPath(change, ['path', 'file_path', 'filePath']);
      if (!filePath) continue;
      const oldString = readPath(change, ['old_string', 'oldString', 'before', 'oldText', 'previousContent']);
      const newString = readPath(change, ['new_string', 'newString', 'after', 'newText', 'content']);
      const patch = readPath(change, ['patch', 'diff', 'unifiedDiff']);
      extracted.push({
        filePath,
        toolName,
        edits: [{
          oldString,
          newString,
          patch,
          label: changes.length > 1 ? `Change ${index + 1}` : undefined,
          additions: asNumber(change['additions']),
          deletions: asNumber(change['deletions']),
        }],
      });
    }
    return extracted;
  }

  return [];
}

function parseApplyPatchLikeEdit(oldString: string, newString: string): ExtractedEdits[] {
  if (oldString || !newString.startsWith('*** Begin Patch')) return [];
  const files = new Map<string, { status: string; lines: string[] }>();
  let currentPath = '';
  let currentStatus = '';

  for (const line of newString.split('\n')) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      currentStatus = header[1];
      currentPath = header[2].trim();
      files.set(currentPath, { status: currentStatus, lines: [] });
      continue;
    }
    if (!currentPath || line.startsWith('***')) continue;
    files.get(currentPath)?.lines.push(line);
  }

  return Array.from(files.entries()).map(([filePath, file]) => {
    const oldString = file.status === 'Add' ? '' : file.lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)).join('\n');
    const newString = file.status === 'Delete' ? '' : file.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
    return {
      filePath,
      toolName: 'Edit',
      edits: [{
        oldString,
        newString,
        patch: file.lines.join('\n'),
        label: file.status === 'Add' ? 'Created file' : file.status === 'Delete' ? 'Deleted file' : 'Patch',
        additions: lineCount(newString),
        deletions: lineCount(oldString),
      }],
    };
  });
}

function isToolUseUnit(
  unit: PairedTranscriptUnit,
): unit is Extract<PairedTranscriptUnit, { kind: 'tool' }> {
  return unit.kind === 'tool';
}

function statusForFile(hunks: TurnChangeHunk[]): TurnChangedFile['status'] {
  if (
    hunks.length
    && hunks.every((hunk) => hunk.deletions === 0 && hunk.additions > 0 && !hunk.oldString)
  ) {
    return 'created';
  }
  if (
    hunks.length
    && hunks.every((hunk) => hunk.additions === 0 && hunk.deletions > 0 && !hunk.newString)
  ) {
    return 'deleted';
  }
  return 'modified';
}

/**
 * Computes file-level changes from successful file-writing tool calls inside a turn.
 *
 * Identical edit payloads are counted once so retried tools do not inflate the
 * diff. Multiple edits to the same file stay grouped in chronological order.
 */
export function computeTurnChangeDetails(units: PairedTranscriptUnit[]): TurnChangeDetails | null {
  const seenFingerprints = new Set<string>();
  const files = new Map<string, TurnChangedFile>();

  for (const unit of units) {
    if (!isToolUseUnit(unit)) continue;
    const toolName = unit.call.toolName ?? '';
    if (!FILE_WRITING_TOOLS.has(normalizeToolName(toolName))) continue;
    if (unit.result?.isError) continue;

    for (const extracted of extractEdits(toolName, unit.call.toolInput)) {
      let file = files.get(extracted.filePath);
      if (!file) {
        file = {
          path: extracted.filePath,
          status: 'modified',
          additions: 0,
          deletions: 0,
          hunks: [],
        };
        files.set(extracted.filePath, file);
      }

      for (const edit of extracted.edits) {
        const fp = [
          extracted.toolName,
          extracted.filePath,
          edit.oldString,
          edit.newString,
          edit.patch ?? '',
        ].join('\u0000');
        if (seenFingerprints.has(fp)) continue;
        seenFingerprints.add(fp);

        const diff = countLineDiff(edit.oldString, edit.newString);
        const additions = edit.additions ?? diff.additions;
        const deletions = edit.deletions ?? diff.deletions;
        if (additions === 0 && deletions === 0 && !edit.patch) continue;

        file.additions += additions;
        file.deletions += deletions;
        file.hunks.push({
          id: `${unit.toolUseId}:${file.hunks.length}`,
          toolName: extracted.toolName,
          label: edit.label ?? extracted.toolName,
          oldString: edit.oldString,
          newString: edit.newString,
          additions,
          deletions,
          patch: edit.patch,
          startLine: edit.startLine,
        });
      }

      if (file.hunks.length === 0) {
        files.delete(extracted.filePath);
      } else {
        file.status = statusForFile(file.hunks);
      }
    }
  }

  const filesChanged = Array.from(files.values());
  if (!filesChanged.length) return null;

  return {
    files: filesChanged.length,
    additions: filesChanged.reduce((sum, file) => sum + file.additions, 0),
    deletions: filesChanged.reduce((sum, file) => sum + file.deletions, 0),
    filesChanged,
  };
}

export function computeTurnChangeSummary(units: PairedTranscriptUnit[]): TurnChangeSummary | null {
  const details = computeTurnChangeDetails(units);
  return details ? { files: details.files, additions: details.additions, deletions: details.deletions } : null;
}

export function computeTurnChangeSummaryFromItems(
  items: ClaudeTranscriptItem[],
): TurnChangeSummary | null {
  const details = computeTurnChangeDetailsFromItems(items);
  return details ? { files: details.files, additions: details.additions, deletions: details.deletions } : null;
}

export function computeTurnChangeDetailsFromItems(
  items: ClaudeTranscriptItem[],
): TurnChangeDetails | null {
  const resultsByToolUseId = new Map<string, ClaudeTranscriptItem>();
  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId) {
      resultsByToolUseId.set(item.toolUseId, item);
    }
  }
  const units: PairedTranscriptUnit[] = [];
  for (const item of items) {
    if (item.kind !== 'tool_use') continue;
    const toolUseId = item.toolUseId || item.id;
    units.push({
      kind: 'tool',
      id: item.id,
      call: item,
      result: resultsByToolUseId.get(toolUseId) ?? null,
      toolUseId,
    });
  }
  return computeTurnChangeDetails(units);
}
