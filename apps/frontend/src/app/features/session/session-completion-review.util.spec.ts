import { describe, expect, it } from 'vitest';
import { shouldAutoReviewSessionCompletion } from './session-completion-review.util';

describe('shouldAutoReviewSessionCompletion', () => {
  it('returns true when the completion belongs to the active session tab', () => {
    expect(shouldAutoReviewSessionCompletion(42, 42, true)).toBe(true);
  });

  it('returns false when the completion belongs to another session', () => {
    expect(shouldAutoReviewSessionCompletion(42, 7, true)).toBe(false);
  });

  it('returns false when the completion is already reviewed', () => {
    expect(shouldAutoReviewSessionCompletion(42, 42, false)).toBe(false);
  });
});
