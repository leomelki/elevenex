import { describe, expect, it } from 'vitest';

import type { ChangeReviewFileSummary } from '@/shared/models/change-review.model';
import {
  CHANGE_REVIEW_HEADER_ROWS,
  ChangeReviewVirtualLayout,
  estimateChangeReviewDiffRows,
} from './change-review-virtual-layout';

const file = (
  path: string,
  additions: number,
  deletions: number,
  overrides: Partial<ChangeReviewFileSummary> = {},
): ChangeReviewFileSummary => ({
  path,
  oldPath: null,
  status: 'modified',
  additions,
  deletions,
  binary: false,
  large: false,
  size: null,
  ...overrides,
});

describe('ChangeReviewVirtualLayout', () => {
  it('maps global rows to file headers and diff rows', () => {
    const layout = new ChangeReviewVirtualLayout([
      { path: 'a.ts', diffRows: 3 },
      { path: 'b.ts', diffRows: 2 },
    ]);

    expect(layout.totalRows).toBe(CHANGE_REVIEW_HEADER_ROWS + 3 + CHANGE_REVIEW_HEADER_ROWS + 2);
    expect(layout.positionForIndex(0)).toMatchObject({ path: 'a.ts', kind: 'header', headerIndex: 0 });
    expect(layout.positionForIndex(1)).toMatchObject({ path: 'a.ts', kind: 'header', headerIndex: 1 });
    expect(layout.positionForIndex(2)).toMatchObject({ path: 'a.ts', kind: 'diff', diffIndex: 0 });
    expect(layout.positionForIndex(5)).toMatchObject({ path: 'b.ts', kind: 'header', headerIndex: 0 });
    expect(layout.positionForIndex(7)).toMatchObject({ path: 'b.ts', kind: 'diff', diffIndex: 0 });
  });

  it('computes visible file segments without materializing diff rows', () => {
    const layout = new ChangeReviewVirtualLayout([
      { path: 'a.ts', diffRows: 10 },
      { path: 'b.ts', diffRows: 10 },
      { path: 'c.ts', diffRows: 10 },
    ]);

    const segments = layout.segmentsForRange(11, 16);

    expect(segments.map((segment) => segment.path)).toEqual(['a.ts', 'b.ts']);
    expect(segments[0]).toMatchObject({ diffStart: 9, diffEnd: 10, includesHeader: false });
    expect(segments[1]).toMatchObject({ rowStart: 0, diffStart: 0, diffEnd: 2, includesHeader: true });
  });

  it('preserves anchors when estimated row counts become exact', () => {
    const estimated = new ChangeReviewVirtualLayout([
      { path: 'a.ts', diffRows: 30 },
      { path: 'b.ts', diffRows: 30 },
    ]);
    const anchor = estimated.anchorForScrollTop((CHANGE_REVIEW_HEADER_ROWS + 30 + 4) * 24 + 7, 24);

    const exact = estimated.withDiffRows('a.ts', 8);

    expect(anchor).toEqual({ path: 'b.ts', rowInFile: 4, offsetPx: 7 });
    expect(exact.scrollTopForAnchor(anchor!, 24)).toBe((CHANGE_REVIEW_HEADER_ROWS + 8 + 4) * 24 + 7);
  });

  it('updates total rows after context expansion changes a file row count', () => {
    const layout = new ChangeReviewVirtualLayout([
      { path: 'a.ts', diffRows: 5 },
      { path: 'b.ts', diffRows: 5 },
    ]);
    const expanded = layout.withDiffRows('a.ts', 9);

    expect(expanded.totalRows).toBe(layout.totalRows + 4);
    expect(expanded.fileStart('b.ts')).toBe(layout.fileStart('b.ts')! + 4);
  });

  it('estimates binary and textual file row counts', () => {
    expect(estimateChangeReviewDiffRows(file('image.png', 0, 0, { binary: true }), 8)).toBe(1);
    expect(estimateChangeReviewDiffRows(file('large.txt', 100_000, 0, { large: true }), 8)).toBe(1);
    expect(estimateChangeReviewDiffRows(file('src/app.ts', 10, 5), 8)).toBe(33);
  });
});
