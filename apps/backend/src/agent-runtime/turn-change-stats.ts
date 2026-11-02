import { diffLines } from 'diff';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

/**
 * Backend port of the frontend per-turn change computation
 * (`apps/frontend/.../claude-workspace/util/turn-change-stats.ts`).
 *
 * Only the items-based path is ported here — the export feature feeds raw
 * `ClaudeTranscriptItem[]` (the normalized history shared by claude/codex/pi), so
 * the `PairedTranscriptUnit` dependency from the frontend is not needed. Changes are
 * derived from persisted turn snapshots, with successful native tool edits as
 * fallback for older history and files outside the captured scope.
 */

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
  status?: TurnChangedFile['status'];
  filePath: string;
  toolName: string;
  edits: EditOp[];
}

interface ToolUnit {
  call: ClaudeTranscriptItem;
  result: ClaudeTranscriptItem | null;
  toolUseId: string;
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

function countLineDiff(
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
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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

  const numberedLines = numbered.map((line) =>
    normalizeLineForMatch(line.text),
  );
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
    const oldString = asString(record['old_string']);
    const newString = asString(record['new_string']);
    const patchEntries = parseApplyPatchLikeEdit(oldString, newString);
    if (patchEntries.length) return patchEntries;

    const filePath = readPath(record, ['file_path', 'filePath', 'path']);
    if (!filePath) return [];
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
    const raw = Array.isArray(record['edits'])
      ? (record['edits'] as unknown[])
      : [];
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
    const filePath = readPath(record, [
      'notebook_path',
      'notebookPath',
      'file_path',
      'path',
    ]);
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
    const changes = Array.isArray(record['changes'])
      ? (record['changes'] as unknown[])
      : [];
    const extracted: ExtractedEdits[] = [];
    for (const [index, entry] of changes.entries()) {
      const change = asRecord(entry);
      if (!change) continue;
      const filePath = readPath(change, ['path', 'file_path', 'filePath']);
      if (!filePath) continue;
      const oldString = readPath(change, [
        'old_string',
        'oldString',
        'before',
        'oldText',
        'previousContent',
      ]);
      const newString = readPath(change, [
        'new_string',
        'newString',
        'after',
        'newText',
        'content',
      ]);
      let patch = readPath(change, ['patch', 'diff', 'unifiedDiff']);
      const kind = asString(change['kind']) || asString(asRecord(change['kind'])?.['type']);
      const created = kind === 'add' || kind === 'create';
      const deleted = kind === 'delete';
      const plainContent = (created || deleted) && patch && !/^@@ /m.test(patch) && !/^[+-]/m.test(patch) ? patch : undefined;
      if (plainContent) patch = '';
      const addedLines = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
      const deletedLines = patch.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
      extracted.push({
        filePath,
        toolName,
        status: created ? 'created' : deleted ? 'deleted' : kind === 'update' || kind === 'modify' ? 'modified' : undefined,
        edits: [
          {
            oldString: deleted && plainContent ? plainContent : oldString,
            newString: created && plainContent ? plainContent : newString,
            patch,
            label: changes.length > 1 ? `Change ${index + 1}` : undefined,
            additions: asNumber(change['additions']) ?? (patch ? addedLines : undefined),
            deletions: asNumber(change['deletions']) ?? (patch ? deletedLines : undefined),
          },
        ],
      });
    }
    return extracted;
  }

  return [];
}

function parseApplyPatchLikeEdit(
  oldString: string,
  newString: string,
): ExtractedEdits[] {
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

function statusForFile(hunks: TurnChangeHunk[]): TurnChangedFile['status'] {
  if (
    hunks.length &&
    hunks.every(
      (hunk) => hunk.deletions === 0 && hunk.additions > 0 && !hunk.oldString,
    )
  ) {
    return 'created';
  }
  if (
    hunks.length &&
    hunks.every(
      (hunk) => hunk.additions === 0 && hunk.deletions > 0 && !hunk.newString,
    )
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
function computeTurnChangeDetails(units: ToolUnit[]): TurnChangeDetails | null {
  const seenFingerprints = new Set<string>();
  const files = new Map<string, TurnChangedFile>();

  for (const unit of units) {
    const toolName = unit.call.toolKind && unit.call.toolKind !== 'unknown' ? unit.call.toolKind : unit.call.toolName ?? '';
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
      typeof unit.result?.content === 'string'
        ? unit.result.content
        : undefined;

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
        ].join(' ');
        if (seenFingerprints.has(fp)) continue;
        seenFingerprints.add(fp);

        const diff = countLineDiff(edit.oldString, edit.newString);
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
        file.status = extracted.status ?? statusForFile(file.hunks);
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

export function computeTurnChangeDetailsFromItems(
  items: ClaudeTranscriptItem[],
): TurnChangeDetails | null {
  const resultsByToolUseId = new Map<string, ClaudeTranscriptItem>();
  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId) {
      resultsByToolUseId.set(item.toolUseId, item);
    }
  }
  const units: ToolUnit[] = [];
  for (const item of items) {
    if (item.kind !== 'tool_use') continue;
    const toolUseId = item.toolUseId || item.id;
    units.push({
      call: item,
      result: resultsByToolUseId.get(toolUseId) ?? null,
      toolUseId,
    });
  }
  return reconcileCapturedChanges(computeTurnChangeDetails(units), items);
}

/** Filesystem net changes replace overlapping tool payloads, while edits outside
 * the observed scope (for example explicitly edited ignored files) survive. */
export function reconcileCapturedChanges(
  native: TurnChangeDetails | null,
  items: ClaudeTranscriptItem[],
): TurnChangeDetails | null {
  const snapshot = items.findLast((item) => item.turnChanges)?.turnChanges;
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

/** Older/replayed Claude turns can already contain shell diffs even when no
 * Elevenex snapshot exists. Preserve the provider's shared-ownership marker. */
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
