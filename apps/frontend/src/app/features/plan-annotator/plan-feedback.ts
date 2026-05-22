import { PlanAnnotatorComment, PlanReviewRequest } from './plan-review.model';

export function fingerprintPlan(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function planDraftStorageKey(review: PlanReviewRequest): string {
  return [
    'elevenex',
    'plan-annotator',
    review.sessionId,
    review.provider,
    review.reviewId,
    fingerprintPlan(review.planMarkdown),
  ].join(':');
}

export function formatPlanFeedbackMessage(comments: PlanAnnotatorComment[]): string {
  const sections = comments.map((comment, index) => {
    const lines = [
      `Feedback ${index + 1} (${comment.scope === 'document' ? 'document-wide' : 'selection'}):`,
      '',
    ];

    if (comment.scope === 'selection') {
      lines.push('Selected text:', quoteBlock(comment.quote), '');
      if (comment.context && comment.context !== comment.quote) {
        lines.push('Nearby context:', quoteBlock(comment.context), '');
      }
    }

    lines.push('Requested change:', comment.note);
    return lines.join('\n');
  });

  return [
    'Please revise the proposed plan using the feedback below. Stay in plan mode and do not implement yet.',
    '',
    ...sections.flatMap((section, index) => (index === 0 ? [section] : ['', section])),
  ].join('\n');
}

export function formatPlanRejectionMessage(comments: PlanAnnotatorComment[]): string {
  if (!comments.length) {
    return 'I do not approve this plan; please revise before implementation.';
  }

  return formatPlanFeedbackMessage(comments);
}

function quoteBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
