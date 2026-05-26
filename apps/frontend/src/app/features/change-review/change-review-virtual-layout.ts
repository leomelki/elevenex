import type { ChangeReviewFileSummary } from '@/shared/models/change-review.model';

export const CHANGE_REVIEW_HEADER_ROWS = 2;

export interface ChangeReviewVirtualFile {
  path: string;
  diffRows: number;
  headerRows?: number;
}

export interface ChangeReviewVirtualPosition {
  fileIndex: number;
  path: string;
  rowInFile: number;
  kind: 'header' | 'diff';
  headerIndex: number | null;
  diffIndex: number | null;
}

export interface ChangeReviewVirtualFileSegment {
  fileIndex: number;
  path: string;
  fileStart: number;
  fileEnd: number;
  rowStart: number;
  rowEnd: number;
  diffStart: number;
  diffEnd: number;
  includesHeader: boolean;
}

export interface ChangeReviewVirtualAnchor {
  path: string;
  rowInFile: number;
  offsetPx: number;
}

export function estimateChangeReviewDiffRows(
  file: ChangeReviewFileSummary,
  context: number,
): number {
  if (file.binary || file.large) return 1;
  const changedLines = file.additions + file.deletions;
  if (changedLines <= 0) return 1;
  const estimatedHunks = Math.max(1, Math.ceil(changedLines / 40));
  return Math.max(1, changedLines + estimatedHunks * (context * 2 + 2));
}

export class ChangeReviewVirtualLayout {
  readonly files: readonly ChangeReviewVirtualFile[];
  readonly starts: readonly number[];
  readonly totalRows: number;

  constructor(files: readonly ChangeReviewVirtualFile[]) {
    const starts: number[] = [];
    let offset = 0;
    this.files = files.map((file) => {
      starts.push(offset);
      const diffRows = Math.max(0, Math.floor(file.diffRows));
      const headerRows = Math.max(1, Math.floor(file.headerRows ?? CHANGE_REVIEW_HEADER_ROWS));
      offset += headerRows + diffRows;
      return { path: file.path, diffRows, headerRows };
    });
    this.starts = starts;
    this.totalRows = offset;
  }

  fileStart(path: string): number | null {
    const index = this.files.findIndex((file) => file.path === path);
    return index === -1 ? null : this.starts[index];
  }

  fileEnd(path: string): number | null {
    const index = this.files.findIndex((file) => file.path === path);
    return index === -1
      ? null
      : this.starts[index] + this.headerRowsFor(index) + this.files[index].diffRows;
  }

  positionForIndex(index: number): ChangeReviewVirtualPosition | null {
    if (this.totalRows <= 0) return null;
    const safeIndex = Math.min(this.totalRows - 1, Math.max(0, Math.floor(index)));
    const fileIndex = this.findFileIndex(safeIndex);
    if (fileIndex === -1) return null;

    const file = this.files[fileIndex];
    const rowInFile = safeIndex - this.starts[fileIndex];
    const headerRows = this.headerRowsFor(fileIndex);
    const headerIndex = rowInFile < headerRows ? rowInFile : null;
    const diffIndex = rowInFile >= headerRows
      ? rowInFile - headerRows
      : null;

    return {
      fileIndex,
      path: file.path,
      rowInFile,
      kind: headerIndex === null ? 'diff' : 'header',
      headerIndex,
      diffIndex,
    };
  }

  segmentsForRange(startIndex: number, endIndex: number): ChangeReviewVirtualFileSegment[] {
    if (this.totalRows <= 0 || endIndex <= startIndex) return [];
    const start = Math.max(0, Math.floor(startIndex));
    const end = Math.min(this.totalRows, Math.ceil(endIndex));
    if (end <= start) return [];

    const segments: ChangeReviewVirtualFileSegment[] = [];
    let fileIndex = this.findFileIndex(start);
    if (fileIndex === -1) return segments;

    while (fileIndex < this.files.length) {
      const file = this.files[fileIndex];
      const fileStart = this.starts[fileIndex];
      const headerRows = this.headerRowsFor(fileIndex);
      const fileEnd = fileStart + headerRows + file.diffRows;
      if (fileStart >= end) break;

      const rowStart = Math.max(start, fileStart) - fileStart;
      const rowEnd = Math.min(end, fileEnd) - fileStart;
      const diffStart = Math.max(0, rowStart - headerRows);
      const diffEnd = Math.max(0, rowEnd - headerRows);

      segments.push({
        fileIndex,
        path: file.path,
        fileStart,
        fileEnd,
        rowStart,
        rowEnd,
        diffStart,
        diffEnd,
        includesHeader: rowStart < headerRows,
      });

      fileIndex += 1;
    }

    return segments;
  }

  anchorForScrollTop(scrollTop: number, rowHeight: number): ChangeReviewVirtualAnchor | null {
    const index = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const position = this.positionForIndex(index);
    if (!position) return null;
    return {
      path: position.path,
      rowInFile: position.rowInFile,
      offsetPx: Math.max(0, scrollTop - index * rowHeight),
    };
  }

  scrollTopForAnchor(anchor: ChangeReviewVirtualAnchor, rowHeight: number): number {
    const fileIndex = this.files.findIndex((file) => file.path === anchor.path);
    if (fileIndex === -1) return 0;
    const file = this.files[fileIndex];
    const fileRows = this.headerRowsFor(fileIndex) + file.diffRows;
    const rowInFile = Math.min(Math.max(0, anchor.rowInFile), Math.max(0, fileRows - 1));
    return (this.starts[fileIndex] + rowInFile) * rowHeight + Math.max(0, anchor.offsetPx);
  }

  withDiffRows(path: string, diffRows: number): ChangeReviewVirtualLayout {
    return new ChangeReviewVirtualLayout(this.files.map((file) => file.path === path
      ? { ...file, diffRows }
      : file));
  }

  private findFileIndex(index: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    let result = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.starts[mid] <= index) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  private headerRowsFor(fileIndex: number): number {
    return Math.max(1, this.files[fileIndex].headerRows ?? CHANGE_REVIEW_HEADER_ROWS);
  }
}
