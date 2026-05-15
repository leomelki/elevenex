import { describe, expect, it } from 'vitest';
import { extractProposedPlan, hasProposedPlan } from './proposed-plan';

describe('proposed-plan utils', () => {
  it('extracts markdown inside proposed_plan tags', () => {
    expect(
      extractProposedPlan('Intro\n<proposed_plan>\n# Plan\n\n- Step one\n</proposed_plan>\nOutro'),
    ).toEqual({
      plan: '# Plan\n\n- Step one',
      before: 'Intro',
      after: 'Outro',
      closed: true,
    });
  });

  it('supports streaming content before the closing tag arrives', () => {
    expect(extractProposedPlan('<proposed_plan>\nDraft step')).toEqual({
      plan: 'Draft step',
      before: '',
      after: '',
      closed: false,
    });
  });

  it('reports whether content contains a proposed plan', () => {
    expect(hasProposedPlan('<proposed_plan>Plan</proposed_plan>')).toBe(true);
    expect(hasProposedPlan('regular assistant markdown')).toBe(false);
  });
});
