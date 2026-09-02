import { describe, expect, it } from 'vitest';
import type { ChangeReviewRow } from '@/shared/models/change-review.model';
import type { ReviewAnchor, ReviewChat } from '@/shared/models/review-chat.model';
import {
  anchorLabel,
  buildAnchorRowIndex,
  relocateAnchor,
  resolveAnchorState,
  reviewChatAnchorState,
} from './review-anchors';

function anchor(overrides: Partial<ReviewAnchor> = {}): ReviewAnchor {
  return {
    id: 'anchor-1',
    version: 1,
    scope: 'branch',
    compareLabel: null,
    baseSha: null,
    headSha: null,
    filePath: 'src/app/foo.ts',
    oldPath: null,
    status: 'modified',
    changeHash: 'hash-1',
    oldLineStart: null,
    oldLineEnd: null,
    newLineStart: 12,
    newLineEnd: 13,
    selectedText: 'a\nb',
    context: {
      before: [],
      selected: [
        { type: 'add', oldLine: null, newLine: 12, content: 'a' },
        { type: 'add', oldLine: null, newLine: 13, content: 'b' },
      ],
      after: [],
    },
    truncated: false,
    ...overrides,
  };
}

function chat(overrides: Partial<ReviewChat> = {}): ReviewChat {
  return {
    id: 1,
    parentSessionId: 10,
    childSessionId: 11,
    provider: 'claude',
    title: 'foo.ts:12-13',
    mode: 'readonly',
    status: 'open',
    scope: 'branch',
    filePath: 'src/app/foo.ts',
    anchors: [anchor()],
    changeHash: 'hash-1',
    fingerprint: 'fp-1',
    anchorMessageId: 'uuid',
    anchorMessageKind: 'assistant',
    turnKey: null,
    promotedForkId: null,
    lastReadAt: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const row = (content: string, newLine: number): ChangeReviewRow => ({
  id: `r${newLine}`,
  type: 'context',
  oldLine: newLine,
  newLine,
  content,
  path: 'src/app/foo.ts',
});

describe('resolveAnchorState', () => {
  it('is exact when the file content is unchanged', () => {
    expect(
      resolveAnchorState(anchor(), 'fp-1', {
        fingerprint: 'fp-1',
        changeHash: 'hash-9',
      }),
    ).toBe('exact');
  });

  it('is moved when the content changed but the diff rows still match', () => {
    expect(
      resolveAnchorState(anchor(), 'fp-1', {
        fingerprint: 'fp-2',
        changeHash: 'hash-1',
      }),
    ).toBe('moved');
  });

  it('is drifted when neither identity matches', () => {
    expect(
      resolveAnchorState(anchor(), 'fp-1', {
        fingerprint: 'fp-2',
        changeHash: 'hash-2',
      }),
    ).toBe('drifted');
  });

  it('is drifted when the file is no longer in the diff at all', () => {
    expect(resolveAnchorState(anchor(), 'fp-1', null)).toBe('drifted');
  });

  it('treats a discussion with no anchors as drifted', () => {
    expect(
      reviewChatAnchorState(chat({ anchors: [] }), {
        fingerprint: 'fp-1',
        changeHash: 'hash-1',
      }),
    ).toBe('drifted');
  });
});

describe('buildAnchorRowIndex', () => {
  it('indexes every anchored row against its discussion', () => {
    const index = buildAnchorRowIndex([chat()]);

    expect(index.size).toBe(2);
    expect([...index.values()]).toEqual([[1], [1]]);
  });

  it('collects several discussions anchored to the same row', () => {
    const index = buildAnchorRowIndex([chat(), chat({ id: 2 })]);

    expect([...index.values()][0]).toEqual([1, 2]);
  });

  it('omits resolved discussions so their markers disappear', () => {
    const index = buildAnchorRowIndex([chat({ status: 'resolved' })]);

    expect(index.size).toBe(0);
  });

  it('keeps promoted discussions visible', () => {
    const index = buildAnchorRowIndex([chat({ status: 'promoted' })]);

    expect(index.size).toBe(2);
  });
});

describe('relocateAnchor', () => {
  it('finds the selection at its new position', () => {
    const rows = [row('x', 1), row('a', 2), row('b', 3)];

    expect(relocateAnchor(anchor(), rows)).toBe(1);
  });

  it('refuses to guess when the selection appears more than once', () => {
    // Picking one of several identical candidates would silently point the
    // discussion at the wrong code.
    const rows = [row('a', 1), row('b', 2), row('a', 3), row('b', 4)];

    expect(relocateAnchor(anchor(), rows)).toBeNull();
  });

  it('returns null when the selection is gone', () => {
    expect(relocateAnchor(anchor(), [row('x', 1), row('y', 2)])).toBeNull();
  });

  it('returns null for an anchor with no selected rows', () => {
    const empty = anchor({
      context: { before: [], selected: [], after: [] },
    });

    expect(relocateAnchor(empty, [row('a', 1)])).toBeNull();
  });
});

describe('anchorLabel', () => {
  it('renders a basename and line range', () => {
    expect(anchorLabel(anchor())).toBe('foo.ts:12-13');
  });

  it('collapses a single-line range', () => {
    expect(anchorLabel(anchor({ newLineStart: 12, newLineEnd: 12 }))).toBe(
      'foo.ts:12',
    );
  });

  it('falls back to the basename when there are no line numbers', () => {
    expect(
      anchorLabel(
        anchor({ newLineStart: null, newLineEnd: null, oldLineStart: null }),
      ),
    ).toBe('foo.ts');
  });
});
