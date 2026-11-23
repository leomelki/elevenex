import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SessionChatChangeSummary } from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import {
  UNKNOWN_IGNORED_FILE_BASELINE,
  computeTurnChangeDetailsFromItems,
  reconcileCapturedChanges,
  type TurnChangedFile,
  type TurnChangeDetails,
} from '../agent-runtime/turn-change-stats.js';
import { chatItemFailed, commandExecution, record } from './desktop-chat-tool-outcome.js';
import { ChatToolLinks } from './desktop-chat-tool-links.js';

const fileTools = new Set(['write', 'edit', 'file_changes', 'notebook_edit', 'bash']);

export function changedFile(file: TurnChangedFile) {
  return {
    path: file.path.slice(0, 1000),
    status:
      file.status === 'created'
        ? ('A' as const)
        : file.status === 'deleted'
          ? ('D' as const)
          : ('M' as const),
    add: file.additions,
    del: file.deletions,
  };
}
function sharedChanges(details: TurnChangeDetails) {
  return details.capture?.shared || details.filesChanged.some(file => file.attribution === 'shared')
    ? { shared: true as const } : {};
}

export function changeSummary(details: TurnChangeDetails | null | undefined, limit = 200): SessionChatChangeSummary | undefined {
  if (!details) return undefined;
  const files = details.filesChanged;
  const lineTotals = files.length > limit ? files.reduce((totals, file) => {
    totals.add += file.additions;
    totals.del += file.deletions;
    return totals;
  }, { add: 0, del: 0 }) : undefined;
  return { files: files.slice(0, limit).map(changedFile), total: files.length,
    ...(lineTotals ? { lineTotals } : {}), ...sharedChanges(details) };
}

/** Never run fallback diff computation on unbounded provider tool arguments. */
export function toolChanges(
  call: AgentTranscriptItem,
  result: AgentTranscriptItem,
) {
  if (
    chatItemFailed(result, commandExecution(result, call)) ||
    !fileTools.has(call.toolKind ?? '') ||
    (call.toolKind === 'bash' && !record(result.providerToolResult).bashEditDiff)
  )
    return null;
  if (
    JSON.stringify(call.toolInput ?? '').length > 32000 ||
    JSON.stringify(result.providerToolResult ?? '').length > 32000
  )
    return null;
  return computeTurnChangeDetailsFromItems([call, result]);
}

function verifiedCapture(snapshot: AgentTranscriptItem): AgentTranscriptItem {
  const capture = snapshot.turnChanges;
  if (!capture?.filesChanged.some(file => file.diffUnavailable === UNKNOWN_IGNORED_FILE_BASELINE)) return snapshot;
  // A watcher notification with no starting state cannot establish a net
  // change. Leave this path available for corroboration by native tool edits.
  return { ...snapshot, turnChanges: {
    ...capture,
    filesChanged: capture.filesChanged.filter(file => file.diffUnavailable !== UNKNOWN_IGNORED_FILE_BASELINE),
  } };
}

/** Reconcile metadata without rerunning provider diffs on every streamed token. */
export function capturedChangeSummary(
  snapshot: AgentTranscriptItem,
  summaries: readonly ReturnType<typeof changeSummary>[],
) {
  const files = new Map<string, TurnChangedFile>();
  for (const summary of summaries)
    for (const file of summary?.files ?? []) {
      const previous = files.get(file.path);
      files.set(file.path, {
        path: file.path,
        status:
          file.status === 'A'
            ? 'created'
            : file.status === 'D'
              ? 'deleted'
              : 'modified',
        additions: file.add + (previous?.additions ?? 0),
        deletions: file.del + (previous?.deletions ?? 0),
        hunks: [],
      });
    }
  const filesChanged = [...files.values()];
  const summary = (
    changeSummary(
      reconcileCapturedChanges(
        {
          files: filesChanged.length,
          additions: 0,
          deletions: 0,
          filesChanged,
        },
        [verifiedCapture(snapshot)],
      ),
    ) ?? { files: [], total: 0 }
  );
  return summaries.some(edit => edit?.shared) ? { ...summary, shared: true as const } : summary;
}

function nativeChanges(turn: readonly AgentTranscriptItem[]) {
  const links = new ChatToolLinks(turn);
  const pairs: AgentTranscriptItem[] = [];
  let budget = 256 * 1024;
  for (const call of turn) {
    if (call.kind !== 'tool_use') continue;
    if (pairs.length >= 640) break;
    // Older records can still identify the editor by its provider name.
    if (call.toolKind && call.toolKind !== 'unknown' && !fileTools.has(call.toolKind)) continue;
    const result = links.peer(call);
    if (!result || chatItemFailed(call) || chatItemFailed(result, commandExecution(result, call))) continue;
    if (call.toolKind === 'bash' && !record(result.providerToolResult).bashEditDiff) continue;
    const size = Buffer.byteLength(JSON.stringify(call.toolInput ?? ''));
    if (size > 32000 || size > budget) continue;
    budget -= size;
    pairs.push(call, {
      ...result,
      content: result.content?.slice(0, 32000),
      providerToolResult:
        JSON.stringify(result.providerToolResult ?? '').length <= 32000
          ? result.providerToolResult
          : undefined,
    });
  }
  return computeTurnChangeDetailsFromItems(pairs);
}

function turnChanges(turn: readonly AgentTranscriptItem[], native = nativeChanges(turn)) {
  const capture = turn.findLast(item => item.turnChanges);
  return reconcileCapturedChanges(native, capture ? [verifiedCapture(capture)] : []);
}

/** The compact and full transcript use the same reconciled change list as Review. */
export function summarizeTurnChanges(turn: readonly AgentTranscriptItem[], limit?: number): SessionChatChangeSummary | undefined {
  return changeSummary(turnChanges(turn), limit) ??
    (turn.some(item => item.turnChanges) ? { files: [], total: 0 } : undefined);
}
export interface ChangeLine {
  id: string;
  kind: 'context' | 'add' | 'del';
  oldNumber?: number;
  newNumber?: number;
  text: string;
}
/** Linear patch decoding only; expensive diff generation already belongs to turn capture. */
function* fileLines(file: TurnChangedFile): Generator<ChangeLine> {
  for (const [index, hunk] of file.hunks.entries()) {
    let old =
      hunk.oldStartLine ??
      hunk.startLine ??
      (file.status === 'deleted' ? 1 : undefined);
    let next =
      hunk.newStartLine ??
      hunk.startLine ??
      (file.status === 'created' ? 1 : undefined);
    if (hunk.patch) {
      let inHunk = false;
      let lineIndex = 0;
      for (const text of hunk.patch.split('\n')) {
        const heading = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (heading) {
          old = Number(heading[1]);
          next = Number(heading[2]);
          inHunk = true;
          continue;
        }
        if (
          (!inHunk && /^(diff |index |--- |\+\+\+ )/.test(text)) ||
          !/^[ +\-]/.test(text)
        )
          continue;
        const kind =
          text[0] === '+' ? 'add' : text[0] === '-' ? 'del' : 'context';
        yield {
          id: `${index}:${lineIndex++}`,
          kind,
          ...(kind !== 'add' && old !== undefined ? { oldNumber: old++ } : {}),
          ...(kind !== 'del' && next !== undefined
            ? { newNumber: next++ }
            : {}),
          text: text.slice(1, 4001),
        };
      }
    } else {
      for (const [kind, text] of [
        ['del', hunk.oldString],
        ['add', hunk.newString],
      ] as const) {
        const lines = text ? text.replace(/\n$/, '').split('\n') : [];
        for (const [lineIndex, line] of lines.entries())
          yield {
            id: `${index}:${kind}:${lineIndex}`,
            kind,
            ...(kind === 'del' && old !== undefined
              ? { oldNumber: old++ }
              : {}),
            ...(kind === 'add' && next !== undefined
              ? { newNumber: next++ }
              : {}),
            text: line.slice(0, 4000),
          };
      }
    }
  }
}

export interface PreparedTurnChanges {
  readonly turnId: string;
  readonly revision: string;
  readonly files: readonly TurnChangedFile[];
  readonly shared?: true;
}

export function prepareTurnChanges(
  items: readonly AgentTranscriptItem[],
  turnId: string,
): PreparedTurnChanges {
  const start = items.findIndex(
    (item) => item.id === turnId || `history-${item.id}` === turnId,
  );
  if (start < 0)
    throw new BadRequestException(
      'This reply is no longer available. Reopen the session.',
    );
  let end = start + 1;
  while (end < items.length && items[end].kind !== 'user') end++;
  const turn = items.slice(start, end);
  // A persisted capture is already a net diff, including shell and external edits.
  const native = nativeChanges(turn);
  const details = turnChanges(turn, native);
  const files = details?.filesChanged ?? [];
  const revision = createHash('sha256')
    .update(turn.findLast((item) => item.turnChanges)?.id ?? '')
    .update(JSON.stringify(native))
    .digest('hex');
  return { turnId, revision, files, ...(details ? sharedChanges(details) : {}) };
}

export function turnChangesPage(
  items: AgentTranscriptItem[],
  turnId: string,
  offset: number,
  path?: string,
  lineOffset = 0,
  expectedRevision?: string,
) {
  return preparedChangesPage(
    prepareTurnChanges(items, turnId),
    offset,
    path,
    lineOffset,
    expectedRevision,
  );
}

export function preparedChangesPage(
  prepared: PreparedTurnChanges,
  offset: number,
  path?: string,
  lineOffset = 0,
  expectedRevision?: string,
) {
  const { turnId, revision, files, shared } = prepared;
  if (expectedRevision && revision !== expectedRevision)
    throw new BadRequestException(
      'These changes were updated. Reopen the review.',
    );
  const selected =
    path === undefined ? undefined : files.find((file) => file.path === path);
  if (path !== undefined && !selected)
    throw new BadRequestException('This file is no longer part of the reply.');
  const pageOffset = selected
    ? Math.floor(files.indexOf(selected) / 100) * 100
    : offset;
  if (pageOffset > files.length)
    throw new BadRequestException('Invalid changes page.');
  const lines: ChangeLine[] = [];
  let more = false;
  if (selected) {
    let cursor = 0,
      bytes = 0;
    for (const line of fileLines(selected)) {
      if (cursor++ < lineOffset) continue;
      const size = Buffer.byteLength(JSON.stringify(line));
      if (lines.length >= 400 || bytes + size > 128 * 1024) {
        more = true;
        break;
      }
      bytes += size;
      lines.push(line);
    }
  }
  return {
    turnId,
    revision,
    offset: pageOffset,
    files: files.slice(pageOffset, pageOffset + 100).map(changedFile),
    total: files.length,
    ...(shared ? { shared } : {}),
    nextOffset: pageOffset + 100 < files.length ? pageOffset + 100 : null,
    content: selected
      ? {
          path: selected.path,
          lines,
          nextOffset: more ? lineOffset + lines.length : null,
          ...(!lines.length && !more
            ? {
                error:
                  selected.diffUnavailable ??
                  'This transcript does not include a text diff for this file.',
              }
            : {}),
        }
      : null,
  };
}
