import { isAbsolute, relative, resolve, sep } from 'node:path';
import { formatPatch, structuredPatch } from 'diff';
import type { TurnChangedFile, TurnToolEvidence } from './turn-change-stats.js';

const MAX_PROVIDER_FILES = 200;
const MAX_PATCH = 256 * 1024;
export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only used to match provider paths to observed paths. Provider text is evidence,
 * and is never used as a filesystem read request. */
export function evidencePath(root: string, cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const local = relative(root, absolute);
  return local &&
    local.length <= 1000 &&
    !isAbsolute(local) &&
    local !== '..' &&
    !local.startsWith(`..${sep}`)
    ? local.split(sep).join('/')
    : path;
}

function patchCounts(patch: string) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) inHunk = true;
    else if (inHunk && line.startsWith('+')) additions++;
    else if (inHunk && line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function patchFile(
  path: string,
  status: TurnChangedFile['status'],
  patch: string,
  toolId: string,
  toolName: string,
  attribution: TurnChangedFile['attribution'],
  reason?: string,
): TurnChangedFile {
  const { additions, deletions } = patchCounts(patch);
  return {
    path,
    status,
    attribution,
    additions,
    deletions,
    hunks: patch
      ? [
          {
            id: toolId,
            toolName,
            label: toolName,
            additions,
            deletions,
            patch,
            oldString: '',
            newString: '',
          },
        ]
      : [],
    ...(reason ? { diffUnavailable: reason } : {}),
  };
}

export function codexPatch(
  changes: unknown,
  toolId: string,
  root: string,
  cwd: string,
): { files: TurnChangedFile[]; partial: boolean } {
  const files: TurnChangedFile[] = [];
  if (!Array.isArray(changes)) return { files, partial: true };
  let partial = changes.length > MAX_PROVIDER_FILES;
  let bytes = MAX_EVIDENCE_BYTES;
  for (const raw of changes.slice(0, MAX_PROVIDER_FILES)) {
    const entry = object(raw);
    const kind = object(entry.kind);
    const type = kind.type ?? entry.kind;
    if (
      !validEvidencePath(entry.path) ||
      !['add', 'delete', 'update'].includes(String(type))
    ) {
      partial = true;
      continue;
    }
    const path = evidencePath(root, cwd, entry.path);
    const move = validEvidencePath(kind.move_path)
      ? evidencePath(root, cwd, kind.move_path)
      : undefined;
    const status =
      type === 'add' || (move && move !== path)
        ? 'created'
        : type === 'delete'
          ? 'deleted'
          : 'modified';
    let patch = typeof entry.diff === 'string' ? entry.diff : '';
    let reason: string | undefined;
    if (
      patch.length > MAX_PATCH ||
      Buffer.byteLength(patch) > Math.min(bytes, MAX_PATCH)
    ) {
      partial = true;
      reason = 'Provider patch exceeded the inline diff limit';
      patch = '';
    } else if (patch && (type === 'add' || type === 'delete')) {
      // Codex reports full text for added/deleted files, unified text for updates.
      const lines = patch.replace(/\n$/, '').split('\n');
      const prefix = type === 'delete' ? '-' : '+';
      patch = `@@ -${type === 'delete' ? `1,${lines.length}` : '0,0'} +${type === 'add' ? `1,${lines.length}` : '0,0'} @@\n${lines.map((line) => prefix + line).join('\n')}`;
    }
    bytes -= Buffer.byteLength(patch);
    if (move && move !== path)
      files.push(
        patchFile(
          path,
          'deleted',
          '',
          toolId,
          'Apply patch',
          'tool',
          `Moved to ${move}`,
        ),
      );
    files.push(
      patchFile(
        move ?? path,
        status,
        patch,
        toolId,
        'Apply patch',
        'tool',
        reason ??
          (move && move !== path && !patch ? `Moved from ${path}` : undefined),
      ),
    );
  }
  return { files, partial };
}

function structuredDiff(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  let bytes = MAX_PATCH;
  const hunks = [];
  for (const raw of value) {
    const { oldStart, oldLines, newStart, newLines, lines } = object(raw);
    const valid = (n: unknown): n is number =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (
      !valid(oldStart) ||
      !valid(oldLines) ||
      !valid(newStart) ||
      !valid(newLines) ||
      !Array.isArray(lines) ||
      lines.length > 20000
    )
      return undefined;
    const text: string[] = [];
    for (const line of lines) {
      if (
        typeof line !== 'string' ||
        !/^[ +\\-]/.test(line) ||
        line.length > bytes
      )
        return undefined;
      bytes -= 1 + Buffer.byteLength(line);
      if (bytes < 0) return undefined;
      text.push(line);
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: text });
  }
  if (!hunks.length) return undefined;
  return formatPatch({
    oldFileName: '',
    newFileName: '',
    oldHeader: undefined,
    newHeader: undefined,
    hunks,
  });
}

export function claudeEdit(
  response: unknown,
  toolName: string,
  toolId: string,
  root: string,
  cwd: string,
): { files: TurnChangedFile[]; partial: boolean } {
  const result = object(response);
  const path = result.filePath;
  if (!validEvidencePath(path)) return { files: [], partial: true };
  const local = evidencePath(root, cwd, path);
  if (
    toolName === 'Write' &&
    result.type === 'create' &&
    typeof result.content === 'string'
  ) {
    const { files, partial } = codexPatch(
      [{ path, kind: 'add', diff: result.content }],
      toolId,
      root,
      cwd,
    );
    for (const file of files)
      for (const hunk of file.hunks) {
        hunk.toolName = toolName;
        hunk.label = toolName;
      }
    return { files, partial };
  }
  let patch = structuredDiff(result.structuredPatch);
  if (
    !patch &&
    toolName === 'Write' &&
    result.type === 'update' &&
    typeof result.originalFile === 'string' &&
    typeof result.content === 'string' &&
    result.originalFile.length + result.content.length <= MAX_PATCH &&
    Buffer.byteLength(result.originalFile) +
      Buffer.byteLength(result.content) <=
      MAX_PATCH
  ) {
    const diff = structuredPatch(
      local,
      local,
      result.originalFile,
      result.content,
      undefined,
      undefined,
      {
        timeout: 20,
        maxEditLength: 10_000,
      },
    );
    if (diff?.hunks.length) patch = formatPatch(diff);
    else if (diff) return { files: [], partial: false };
  }
  if (!patch)
    return {
      files: [],
      partial:
        !Array.isArray(result.structuredPatch) ||
        result.structuredPatch.length > 0,
    };
  return {
    files: [patchFile(local, 'modified', patch, toolId, toolName, 'tool')],
    partial: false,
  };
}

/** Native unified diff payloads. Invocation arguments supply only the path,
 * never the changed lines. Older receipts without a patch use observation. */
export function reportedPatch(
  path: unknown,
  patch: unknown,
  toolId: string,
  toolName: string,
  root: string,
  cwd: string,
  status: TurnChangedFile['status'] = 'modified',
): TurnChangedFile | undefined {
  if (!validEvidencePath(path) || typeof patch !== 'string') return;
  const local = evidencePath(root, cwd, path);
  if (patch.length > MAX_PATCH || Buffer.byteLength(patch) > MAX_PATCH)
    return patchFile(
      local,
      status,
      '',
      toolId,
      toolName,
      'tool',
      'Provider patch exceeded the inline diff limit',
    );
  if (!/^@@ -\d/m.test(patch)) return;
  return patchFile(local, status, patch, toolId, toolName, 'tool');
}

export function openCodeEdits(
  metadata: unknown,
  toolId: string,
  toolName: string,
  root: string,
  cwd: string,
): TurnChangedFile[] {
  const result = object(metadata);
  const entries = Array.isArray(result.files)
    ? result.files.slice(0, MAX_PROVIDER_FILES)
    : result.filediff
      ? [result.filediff]
      : [];
  const files: TurnChangedFile[] = [];
  let bytes = MAX_EVIDENCE_BYTES;
  for (const raw of entries) {
    const entry = object(raw);
    const path = entry.filePath ?? entry.file;
    const move =
      entry.type === 'move' && validEvidencePath(entry.movePath)
        ? entry.movePath
        : undefined;
    const status =
      entry.type === 'add' || move
        ? 'created'
        : entry.type === 'delete'
          ? 'deleted'
          : 'modified';
    const patch = entry.patch;
    const file = reportedPatch(
      move ?? path,
      patch,
      toolId,
      toolName,
      root,
      cwd,
      status,
    );
    if (move && validEvidencePath(path))
      files.push(
        patchFile(
          evidencePath(root, cwd, path),
          'deleted',
          '',
          toolId,
          toolName,
          'tool',
          `Moved to ${move}`,
        ),
      );
    if (file) {
      bytes -= Buffer.byteLength(file.hunks[0]?.patch ?? '');
      if (bytes < 0) break;
      files.push(file);
    } else if (
      (move || entry.type === 'add' || entry.type === 'delete') &&
      validEvidencePath(path)
    ) {
      files.push(
        patchFile(
          evidencePath(root, cwd, move ?? path),
          status,
          '',
          toolId,
          toolName,
          'tool',
          'Provider reported the file operation',
        ),
      );
    }
  }
  return files;
}

/** Compare the changed lines and their coordinates to ignore formatting and
 * context differences without collapsing edits to different occurrences. */
export function matchingPatch(a: TurnChangedFile, b: TurnChangedFile): boolean {
  if (a.status !== b.status || !a.hunks.length || !b.hunks.length) return false;
  const changes = (file: TurnChangedFile) =>
    file.hunks.flatMap((hunk) => {
      let old = 0,
        next = 0;
      const result: Array<[number, string]> = [];
      for (const line of hunk.patch?.split('\n') ?? []) {
        const heading = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (heading) {
          old = Number(heading[1]);
          next = Number(heading[2]);
        } else if (line.startsWith('-') && old > 0) result.push([old++, line]);
        else if (line.startsWith('+') && next > 0) result.push([next++, line]);
        else if (line.startsWith('\\ No newline') && result.length)
          result.push([result.at(-1)![0], line]);
        else if (line.startsWith(' ') && (old || next)) {
          old++;
          next++;
        }
      }
      return result;
    });
  const left = changes(a);
  return left.length > 0 && JSON.stringify(left) === JSON.stringify(changes(b));
}

export function claudeShell(
  response: unknown,
  toolName: string,
  toolId: string,
  root: string,
  cwd: string,
): { files: TurnChangedFile[]; partial: boolean; shared: boolean } {
  const diff = object(object(response).bashEditDiff);
  const shared = diff.shared === true;
  if (diff.skipped === true) return { files: [], partial: false, shared };
  let partial = diff.unavailable === true;
  const files = new Map<string, TurnChangedFile>();
  const metadata = Array.isArray(diff.changedFiles) ? diff.changedFiles : [];
  const entries = Array.isArray(diff.files) ? diff.files : [];
  if (
    metadata.length > MAX_PROVIDER_FILES ||
    entries.length > MAX_PROVIDER_FILES
  )
    partial = true;
  const unavailable = 'The provider reported a change without an inline diff';
  const attribution = shared ? 'shared' : 'observed';
  let bytes = MAX_EVIDENCE_BYTES;
  for (const raw of entries.slice(0, MAX_PROVIDER_FILES)) {
    const entry = object(raw);
    if (!validEvidencePath(entry.filePath)) continue;
    const path = evidencePath(root, cwd, entry.filePath);
    const status =
      entry.created === true
        ? 'created'
        : entry.deleted === true
          ? 'deleted'
          : 'modified';
    let patch = structuredDiff(entry.hunks) ?? '';
    const size = Buffer.byteLength(patch);
    if (size > bytes) {
      partial = true;
      patch = '';
    } else bytes -= size;
    files.set(
      path,
      patchFile(
        path,
        status,
        patch,
        toolId,
        toolName,
        attribution,
        patch ? undefined : unavailable,
      ),
    );
  }
  for (const raw of metadata.slice(0, MAX_PROVIDER_FILES)) {
    if (!validEvidencePath(raw) || files.size >= MAX_PROVIDER_FILES) continue;
    const path = evidencePath(root, cwd, raw);
    if (!files.has(path))
      files.set(
        path,
        patchFile(
          path,
          'modified',
          '',
          toolId,
          toolName,
          attribution,
          unavailable,
        ),
      );
  }
  return { files: [...files.values()], partial, shared };
}

function validEvidencePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1000 &&
    !path.includes('\0')
  );
}

export function reviewEvidence(
  tools: readonly TurnToolEvidence[],
  kind: TurnToolEvidence['kind'],
): TurnChangedFile[] {
  const files = new Map<string, TurnChangedFile>();
  const verifiedTransitions = new Map<
    string,
    Array<{
      window: NonNullable<TurnToolEvidence['window']>;
      hunks: TurnChangedFile['hunks'];
    }>
  >();
  for (const tool of tools) {
    if (tool.kind !== kind) continue;
    for (const file of tool.files) {
      const old = files.get(file.path);
      const label = `${tool.toolName} · ${tool.toolId}`.slice(0, 300);
      const transition =
        file.observationKey && tool.window
          ? `${file.path}\0${file.observationKey}`
          : undefined;
      const observations = transition
        ? (verifiedTransitions.get(transition) ?? [])
        : [];
      const window = tool.window;
      const duplicate =
        window &&
        observations.find(
          (previous) =>
            previous.window.start <= window.end &&
            window.start <= previous.window.end,
        );
      if (duplicate) {
        for (const hunk of duplicate.hunks)
          hunk.evidenceLabel = `${hunk.evidenceLabel} / ${label}`.slice(0, 300);
        continue;
      }
      const hunks = file.hunks.map((hunk) => ({
        ...hunk,
        evidenceLabel: hunk.evidenceLabel
          ? `${label} · ${hunk.evidenceLabel}`.slice(0, 300)
          : label,
      }));
      if (transition && window) {
        observations.push({ window, hunks });
        verifiedTransitions.set(transition, observations);
      }
      files.set(file.path, {
        ...file,
        status: old && old.status !== file.status ? 'modified' : file.status,
        attribution:
          old?.attribution === 'shared' ? 'shared' : file.attribution,
        additions: (old?.additions ?? 0) + file.additions,
        deletions: (old?.deletions ?? 0) + file.deletions,
        hunks: [...(old?.hunks ?? []), ...hunks],
        ...(!hunks.length && !old?.hunks.length
          ? {
              diffUnavailable: `${file.diffUnavailable ?? 'No inline diff'} · ${label}`,
            }
          : {}),
      });
    }
  }
  return [...files.values()];
}
