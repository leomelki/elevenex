import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import {
  computeTurnChangeDetailsFromItems,
  reconcileCapturedChanges,
  type TurnChangedFile,
  type TurnChangeDetails,
} from '../agent-runtime/turn-change-stats.js';

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
export function changeSummary(details: TurnChangeDetails | null | undefined) {
  return details
    ? {
        files: details.filesChanged.slice(0, 200).map(changedFile),
        total: details.filesChanged.length,
      }
    : undefined;
}

/** Never run fallback diff computation on unbounded provider tool arguments. */
export function toolChanges(
  call: AgentTranscriptItem,
  result: AgentTranscriptItem,
) {
  if (
    result.isError ||
    !['write', 'edit', 'file_changes', 'notebook_edit', 'bash'].includes(
      call.toolKind ?? '',
    )
  )
    return null;
  if (
    JSON.stringify(call.toolInput ?? '').length > 32000 ||
    JSON.stringify(result.providerToolResult ?? '').length > 32000
  )
    return null;
  return computeTurnChangeDetailsFromItems([call, result]);
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
  return (
    changeSummary(
      reconcileCapturedChanges(
        {
          files: filesChanged.length,
          additions: 0,
          deletions: 0,
          filesChanged,
        },
        [snapshot],
      ),
    ) ?? { files: [], total: 0 }
  );
}

function nativeChanges(turn: readonly AgentTranscriptItem[]) {
  const results = new Map(
    turn
      .filter((item) => item.kind === 'tool_result')
      .map((item) => [item.toolUseId ?? item.id, item]),
  );
  const pairs: AgentTranscriptItem[] = [];
  let budget = 256 * 1024;
  for (const call of turn) {
    if (call.kind !== 'tool_use') continue;
    const result = results.get(call.toolUseId ?? call.id);
    if (!result || result.isError) continue;
    const size = Buffer.byteLength(JSON.stringify(call.toolInput ?? ''));
    if (size > 32000 || size > budget || pairs.length >= 640) continue;
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
}

export function prepareTurnChanges(
  items: AgentTranscriptItem[],
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
  const details = reconcileCapturedChanges(native, turn);
  const files = details?.filesChanged ?? [];
  const revision = createHash('sha256')
    .update(turn.findLast((item) => item.turnChanges)?.id ?? '')
    .update(JSON.stringify(native))
    .digest('hex');
  return { turnId, revision, files };
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
  const { turnId, revision, files } = prepared;
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
