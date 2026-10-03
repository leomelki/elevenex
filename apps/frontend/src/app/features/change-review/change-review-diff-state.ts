import type { ChangeReviewFileSummary, ChangeReviewRow } from '@/shared/models/change-review.model';

export type ContextExpansionDirection = 'down' | 'up';

export interface DiffReplacement {
  baseIndex: number;
  rows: ChangeReviewRow[];
}

export interface FileRenderState {
  file: ChangeReviewFileSummary;
  diffRowCount: number;
  baseRowCount: number | null;
  baseRows: ReadonlyMap<number, ChangeReviewRow>;
  loadingOffsets: ReadonlySet<number>;
  replacements: readonly DiffReplacement[];
  message: string | null;
  binary: boolean;
  large: boolean;
  truncated: boolean;
  changeHash: string | null;
}

export interface ResolvedDiffRow {
  row: ChangeReviewRow | null;
  baseIndex: number | null;
}

export function resolveDiffRow(state: FileRenderState, diffIndex: number): ResolvedDiffRow {
  let shift = 0;
  for (
    let replacementIndex = 0;
    replacementIndex < state.replacements.length;
    replacementIndex += 1
  ) {
    const replacement = state.replacements[replacementIndex];
    const virtualStart = replacement.baseIndex + shift;
    const virtualEnd = virtualStart + replacement.rows.length;
    if (diffIndex < virtualStart) {
      const baseIndex = diffIndex - shift;
      return {
        row: state.baseRows.get(baseIndex) ?? null,
        baseIndex,
      };
    }
    if (diffIndex < virtualEnd) {
      return {
        row: replacement.rows[diffIndex - virtualStart] ?? null,
        baseIndex: null,
      };
    }
    shift += replacement.rows.length - 1;
  }

  const baseIndex = diffIndex - shift;
  return {
    row: state.baseRows.get(baseIndex) ?? null,
    baseIndex,
  };
}

export function contextReplacementRows(
  row: ChangeReviewRow,
  loadedRows: ChangeReviewRow[],
  direction: ContextExpansionDirection,
): ChangeReviewRow[] {
  const remaining = Math.max(0, (row.count ?? 0) - loadedRows.length);
  if (remaining === 0) return loadedRows;

  if (direction === 'up') {
    return [
      expandPlaceholderRow(row, row.oldStart ?? 1, row.newStart ?? 1, remaining),
      ...loadedRows,
    ];
  }

  return [
    ...loadedRows,
    expandPlaceholderRow(
      row,
      (row.oldStart ?? 1) + loadedRows.length,
      (row.newStart ?? 1) + loadedRows.length,
      remaining,
    ),
  ];
}

export function expandPlaceholderRow(
  source: ChangeReviewRow,
  oldStart: number,
  newStart: number,
  count: number,
): ChangeReviewRow {
  return {
    ...source,
    id: `${source.path}:expand:${oldStart}:${newStart}:${count}`,
    oldStart,
    newStart,
    count,
    content: `${count} unchanged line${count === 1 ? '' : 's'}`,
  };
}

export function replaceDiffRow(
  state: FileRenderState,
  rowId: string,
  replacementRows: ChangeReviewRow[],
): FileRenderState {
  for (
    let replacementIndex = 0;
    replacementIndex < state.replacements.length;
    replacementIndex += 1
  ) {
    const replacement = state.replacements[replacementIndex];
    const rowIndex = replacement.rows.findIndex((row) => row.id === rowId);
    if (rowIndex === -1) continue;

    const nextRows = [
      ...replacement.rows.slice(0, rowIndex),
      ...replacementRows,
      ...replacement.rows.slice(rowIndex + 1),
    ];
    const replacements = state.replacements.map((candidate, index) =>
      index === replacementIndex ? { ...candidate, rows: nextRows } : candidate,
    );
    return {
      ...state,
      replacements,
      diffRowCount: diffRowCountFor(state.baseRowCount, state.diffRowCount, replacements),
    };
  }

  for (const [baseIndex, row] of state.baseRows.entries()) {
    if (row.id !== rowId) continue;
    const replacements = [...state.replacements, { baseIndex, rows: replacementRows }].sort(
      (left, right) => left.baseIndex - right.baseIndex,
    );
    return {
      ...state,
      replacements,
      diffRowCount: diffRowCountFor(state.baseRowCount, state.diffRowCount, replacements),
    };
  }

  return state;
}

export function diffRowCountFor(
  baseRowCount: number | null,
  currentDiffRowCount: number,
  replacements: readonly DiffReplacement[],
): number {
  const baseCount = baseRowCount ?? currentDiffRowCount;
  return Math.max(1, baseCount + replacementDelta(replacements));
}

export function replacementDelta(replacements: readonly DiffReplacement[]): number {
  return replacements.reduce((sum, replacement) => sum + replacement.rows.length - 1, 0);
}
