import { PairedTranscriptUnit } from '@/shared/agent-chat/transcript/paired-transcript';
import { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { diffLines } from 'diff';
import { parseFileChanges } from './file-changes';

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
  oldStartLine?: number;
  newStartLine?: number;
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
  attribution?: 'tool' | 'observed' | 'shared';
  diffUnavailable?: string;
}

export interface TurnChangeDetails extends TurnChangeSummary {
  filesChanged: TurnChangedFile[];
  capture?: { root: string; complete: boolean; shared: boolean; message?: string; unchangedPaths?: string[]; aliases?: string[] };
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

const FILE_WRITING_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'filechanges']);

function splitLines(text: string | undefined | null): string[] {
  if (!text) return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split('\n') : [];
}

function lineCount(text: string | undefined | null): number {
  return splitLines(text).length;
}

export function countLineDiff(
  oldStr: string,
  newStr: string,
): { additions: number; deletions: number } {
  const changes = diffLines(oldStr || '', newStr || '');
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    if (change.added) additions += change.count ?? 0;
    else if (change.removed) deletions += change.count ?? 0;
  }
  return { additions, deletions };
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

function normalizeLineForMatch(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function numberedResultLines(
  content: string | undefined,
): Array<{ lineNumber: number; text: string }> {
  if (!content) return [];
  const out: Array<{ lineNumber: number; text: string }> = [];
  for (const rawLine of content.split('\n')) {
    const match = rawLine.match(/^\s*(\d+)(?:\s*→|\t|\s{2,})(.*)$/);
    if (!match) continue;
    const lineNumber = Number(match[1]);
    if (!Number.isFinite(lineNumber)) continue;
    out.push({ lineNumber, text: match[2] ?? '' });
  }
  return out;
}

function inferStartLineFromResult(
  edit: Pick<EditOp, 'oldString' | 'newString'>,
  resultContent: string | undefined,
): number | undefined {
  const numbered = numberedResultLines(resultContent);
  if (!numbered.length) return undefined;

  const referenceLines = (edit.newString || edit.oldString)
    .split('\n')
    .map(normalizeLineForMatch)
    .filter(Boolean);
  if (!referenceLines.length) return undefined;

  const numberedLines = numbered.map((line) => normalizeLineForMatch(line.text));
  for (let i = 0; i < numberedLines.length; i++) {
    if (numberedLines[i] !== referenceLines[0]) continue;
    const matches = referenceLines.every(
      (reference, offset) => numberedLines[i + offset] === reference,
    );
    if (matches) return numbered[i].lineNumber;
  }
  const firstLineMatch = numbered.find(
    (line) => normalizeLineForMatch(line.text) === referenceLines[0],
  );
  return firstLineMatch?.lineNumber;
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
    const filePath = readPath(record, ['file_path', 'filePath', 'path']);
    if (!filePath) return [];

    const rawEdits = Array.isArray(record['edits']) ? (record['edits'] as unknown[]) : [];
    if (rawEdits.length) {
      const edits: EditOp[] = [];
      for (const [index, entry] of rawEdits.entries()) {
        const editRecord = asRecord(entry);
        if (!editRecord) continue;
        edits.push({
          oldString: asString(editRecord['old_string'] ?? editRecord['oldText']),
          newString: asString(editRecord['new_string'] ?? editRecord['newText']),
          label: rawEdits.length > 1 ? `Edit ${index + 1}` : undefined,
          startLine: asNumber(editRecord['__startLine']),
        });
      }
      return edits.length ? [{ filePath, toolName, edits }] : [];
    }

    const oldString = asString(record['old_string']);
    const newString = asString(record['new_string']);
    const patchEntries = parseApplyPatchLikeEdit(oldString, newString);
    if (patchEntries.length) return patchEntries;

    const startLine = asNumber(record['__startLine']);
    return [
      {
        filePath,
        toolName,
        edits: [{ oldString, newString, startLine }],
      },
    ];
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
    return [
      {
        filePath,
        toolName,
        edits: [{ oldString: '', newString: asString(record['content']) }],
      },
    ];
  }

  if (normalized === 'notebookedit') {
    const filePath = readPath(record, ['notebook_path', 'notebookPath', 'file_path', 'path']);
    if (!filePath) return [];
    return [
      {
        filePath,
        toolName,
        edits: [{ oldString: '', newString: asString(record['new_source']) }],
      },
    ];
  }

  if (normalized === 'filechanges') {
    return parseFileChanges(input).map((change) => ({
      filePath: change.path,
      toolName,
      edits: [
        {
          oldString: change.oldString,
          newString: change.newString,
          patch: change.patch || undefined,
          label: change.label,
          additions: change.additions,
          deletions: change.deletions,
        },
      ],
    }));
  }

  return [];
}

export function extractToolEdits(call: AgentTranscriptItem): ExtractedEdits[] {
  const toolName =
    call.toolKind && call.toolKind !== 'unknown' ? call.toolKind : (call.toolName ?? '');
  return extractEdits(toolName, call.toolInput);
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
    const oldString =
      file.status === 'Add'
        ? ''
        : file.lines
            .filter((line) => line.startsWith('-'))
            .map((line) => line.slice(1))
            .join('\n');
    const newString =
      file.status === 'Delete'
        ? ''
        : file.lines
            .filter((line) => line.startsWith('+'))
            .map((line) => line.slice(1))
            .join('\n');
    return {
      filePath,
      toolName: 'Edit',
      edits: [
        {
          oldString,
          newString,
          patch: file.lines.join('\n'),
          label:
            file.status === 'Add'
              ? 'Created file'
              : file.status === 'Delete'
                ? 'Deleted file'
                : 'Patch',
          additions: lineCount(newString),
          deletions: lineCount(oldString),
        },
      ],
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
    hunks.length &&
    hunks.every((hunk) => hunk.deletions === 0 && hunk.additions > 0 && !hunk.oldString)
  ) {
    return 'created';
  }
  if (
    hunks.length &&
    hunks.every((hunk) => hunk.additions === 0 && hunk.deletions > 0 && !hunk.newString)
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
function computeToolChangeDetails(units: PairedTranscriptUnit[]): TurnChangeDetails | null {
  const seenFingerprints = new Set<string>();
  const files = new Map<string, TurnChangedFile>();

  for (const unit of units) {
    if (!isToolUseUnit(unit)) continue;
    const toolName =
      unit.call.toolKind && unit.call.toolKind !== 'unknown'
        ? unit.call.toolKind
        : (unit.call.toolName ?? '');
    if (normalizeToolName(toolName) === 'bash' && !unit.result?.isError) {
      for (const file of nativeBashChanges(unit.result?.providerToolResult, unit.toolUseId)) {
        const previous = files.get(file.path);
        files.set(file.path, previous ? { ...file, additions: previous.additions + file.additions,
          deletions: previous.deletions + file.deletions, hunks: [...previous.hunks, ...file.hunks] } : file);
      }
    }
    if (!FILE_WRITING_TOOLS.has(normalizeToolName(toolName))) continue;
    if (unit.result?.isError) continue;
    const resultContent =
      typeof unit.result?.content === 'string' ? unit.result.content : undefined;

    for (const extracted of extractToolEdits(unit.call)) {
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

        const diff =
          edit.additions === undefined || edit.deletions === undefined
            ? countLineDiff(edit.oldString, edit.newString)
            : { additions: edit.additions, deletions: edit.deletions };
        const additions = edit.additions ?? diff.additions;
        const deletions = edit.deletions ?? diff.deletions;
        if (additions === 0 && deletions === 0 && !edit.patch) continue;
        const inferredStartLine = inferStartLineFromResult(edit, resultContent);

        file.additions += additions;
        file.deletions += deletions;
        file.hunks.push({
          id: `${unit.toolUseId}:${file.hunks.length}`,
          toolName: extracted.toolName,
          label: edit.label ?? extracted.toolName,
          oldString: edit.oldString,
          newString: edit.newString,
          oldStartLine: inferredStartLine,
          newStartLine: inferredStartLine,
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

export function computeTurnChangeDetails(units: PairedTranscriptUnit[]): TurnChangeDetails | null {
  const items = units.flatMap(unit => unit.kind === 'tool' ? [unit.call, ...(unit.result ? [unit.result] : [])] : [unit.item]);
  return reconcileCapturedChanges(computeToolChangeDetails(units), items);
}

export function reconcileCapturedChanges(
  native: TurnChangeDetails | null,
  items: AgentTranscriptItem[],
): TurnChangeDetails | null {
  let snapshot: TurnChangeDetails | undefined;
  for (let i = items.length - 1; i >= 0; i--)
    if (items[i].turnChanges) {
      snapshot = items[i].turnChanges;
      break;
    }
  if (!snapshot) return native;
  const roots = [snapshot.capture?.root, ...(snapshot.capture?.aliases ?? [])]
    .filter((root): root is string => !!root)
    .map((root) => root.replaceAll('\\', '/').replace(/\/$/, ''));
  const key = (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    const root = roots.find((root) => normalized.startsWith(`${root}/`));
    return root
      ? normalized.slice(root.length + 1)
      : normalized.replace(/^\.\//, '');
  };
  const unchanged = new Set(snapshot.capture?.unchangedPaths ?? []);
  const files = new Map(
    (native?.filesChanged ?? [])
      .filter((file) => !unchanged.has(key(file.path)))
      .map((file) => [key(file.path), file]),
  );
  for (const file of snapshot.filesChanged) files.set(key(file.path), file);
  const filesChanged = [...files.values()];
  if (
    !filesChanged.length &&
    snapshot.capture?.complete &&
    !snapshot.capture.message
  )
    return null;
  return {
    ...snapshot,
    files: filesChanged.length,
    filesChanged,
    additions: filesChanged.reduce((n, file) => n + file.additions, 0),
    deletions: filesChanged.reduce((n, file) => n + file.deletions, 0),
  };
}

export function computeTurnChangeSummary(units: PairedTranscriptUnit[]): TurnChangeSummary | null {
  const details = computeTurnChangeDetails(units);
  return details
    ? { files: details.files, additions: details.additions, deletions: details.deletions }
    : null;
}

export function computeTurnChangeSummaryFromItems(
  items: AgentTranscriptItem[],
): TurnChangeSummary | null {
  const details = computeTurnChangeDetailsFromItems(items);
  return details
    ? { files: details.files, additions: details.additions, deletions: details.deletions }
    : null;
}

export function computeTurnChangeDetailsFromItems(
  items: AgentTranscriptItem[],
): TurnChangeDetails | null {
  const resultsByToolUseId = new Map<string, AgentTranscriptItem>();
  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId) {
      resultsByToolUseId.set(item.toolUseId, item);
    }
  }
  const units: PairedTranscriptUnit[] = [];
  for (const item of items) {
    if (item.turnChanges) { units.push({ kind: 'system', id: item.id, item }); continue; }
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

function nativeBashChanges(input: unknown, toolUseId: string): TurnChangedFile[] {
  const diff = asRecord(asRecord(input)?.['bashEditDiff']);
  if (!diff || diff['skipped']) return [];
  const files = new Map<string, TurnChangedFile>();
  const entries = Array.isArray(diff['files'])
    ? diff['files'].slice(0, 200)
    : [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const path = asString(record?.['filePath']);
    if (!path) continue;
    let additions = 0;
    let deletions = 0;
    const hunks: TurnChangeHunk[] = [];
    for (const raw of Array.isArray(record?.['hunks'])
      ? record['hunks'].slice(0, 1000)
      : []) {
      const hunk = asRecord(raw);
      const lines = Array.isArray(hunk?.['lines'])
        ? hunk['lines']
            .filter((line): line is string => typeof line === 'string')
            .slice(0, 10_000)
        : [];
      const added = lines.filter((line) => line.startsWith('+')).length;
      const removed = lines.filter((line) => line.startsWith('-')).length;
      additions += added;
      deletions += removed;
      hunks.push({
        id: `${toolUseId}:bash:${path}:${hunks.length}`,
        toolName: 'Bash',
        label: 'Shell changes',
        oldString: '',
        newString: '',
        additions: added,
        deletions: removed,
        patch: `@@ -${asNumber(hunk?.['oldStart']) ?? 1},${asNumber(hunk?.['oldLines']) ?? 0} +${asNumber(hunk?.['newStart']) ?? 1},${asNumber(hunk?.['newLines']) ?? 0} @@\n${lines.join('\n')}`,
      });
    }
    files.set(path, {
      path,
      status: record?.['created']
        ? 'created'
        : record?.['deleted']
          ? 'deleted'
          : 'modified',
      additions,
      deletions,
      attribution: diff['shared'] ? 'shared' : 'observed',
      hunks,
      ...(!hunks.length
        ? {
            diffUnavailable:
              'The provider reported a change without an inline diff',
          }
        : {}),
    });
  }
  for (const path of Array.isArray(diff['changedFiles'])
    ? diff['changedFiles'].slice(0, 200)
    : []) {
    if (typeof path !== 'string' || files.has(path)) continue;
    files.set(path, {
      path,
      status: 'modified',
      additions: 0,
      deletions: 0,
      hunks: [],
      attribution: diff['shared'] ? 'shared' : 'observed',
      diffUnavailable: 'The provider reported a change without an inline diff',
    });
  }
  return [...files.values()];
}
