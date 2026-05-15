export interface ProposedPlanExtraction {
  plan: string;
  before: string;
  after: string;
  closed: boolean;
}

const OPEN_TAG_RE = /<proposed_plan\b[^>]*>/i;
const CLOSE_TAG_RE = /<\/proposed_plan>/i;

export function extractProposedPlan(content: string | null | undefined): ProposedPlanExtraction | null {
  if (!content) return null;
  const open = OPEN_TAG_RE.exec(content);
  if (!open) return null;

  const start = open.index + open[0].length;
  const tail = content.slice(start);
  const close = CLOSE_TAG_RE.exec(tail);
  if (!close) {
    return {
      plan: tail.trim(),
      before: content.slice(0, open.index).trim(),
      after: '',
      closed: false,
    };
  }

  return {
    plan: tail.slice(0, close.index).trim(),
    before: content.slice(0, open.index).trim(),
    after: tail.slice(close.index + close[0].length).trim(),
    closed: true,
  };
}

export function hasProposedPlan(content: string | null | undefined): boolean {
  return extractProposedPlan(content) !== null;
}
