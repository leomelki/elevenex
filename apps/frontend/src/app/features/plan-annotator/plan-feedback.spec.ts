import { describe, expect, it } from 'vitest';
import {
  fingerprintPlan,
  formatPlanFeedbackMessage,
  formatPlanRejectionMessage,
  planDraftStorageKey,
} from './plan-feedback';
import { PlanAnnotatorComment, PlanReviewRequest } from './plan-review.model';

describe('plan-feedback', () => {
  const review: PlanReviewRequest = {
    provider: 'codex',
    source: 'transcript-plan',
    sessionId: 7,
    reviewId: 'review-1',
    planMarkdown: '# Plan\nDo it',
    createdAt: '2026-05-22T10:00:00.000Z',
  };

  const comments: PlanAnnotatorComment[] = [
    {
      id: 'c1',
      scope: 'selection',
      quote: 'Do it',
      context: '# Plan Do it',
      note: 'Be more specific.',
      createdAt: '2026-05-22T10:00:00.000Z',
      updatedAt: '2026-05-22T10:00:00.000Z',
    },
  ];

  it('builds stable draft keys from review identity and plan fingerprint', () => {
    expect(fingerprintPlan(review.planMarkdown)).toBe(fingerprintPlan(review.planMarkdown));
    expect(planDraftStorageKey(review)).toContain('elevenex:plan-annotator:7:codex:review-1:');
  });

  it('formats structured feedback comments', () => {
    const message = formatPlanFeedbackMessage(comments);

    expect(message).toContain('Stay in plan mode and do not implement yet.');
    expect(message).toContain('Selected text:');
    expect(message).toContain('> Do it');
    expect(message).toContain('Be more specific.');
  });

  it('uses concise rejection copy without comments', () => {
    expect(formatPlanRejectionMessage([])).toBe(
      'I do not approve this plan; please revise before implementation.',
    );
  });
});
