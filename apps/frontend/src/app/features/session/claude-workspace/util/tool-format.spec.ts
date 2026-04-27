import { describe, expect, it } from 'vitest';
import { describeTool, resultSummary } from './tool-format';

describe('tool-format', () => {
  it('uses the ask-user-question prompt text instead of a count label', () => {
    const display = describeTool('AskUserQuestion', {
      questions: [
        { question: 'Which approach should we use?' },
        { question: 'Which tests should we add?' },
      ],
    });

    expect(display.kind).toBe('ask_user_question');
    expect(display.target).toContain('Which approach should we use?');
    expect(display.target).toContain('+1 more');
    expect(display.target).not.toContain('prompt');
  });

  it('prefers interaction summaries for the collapsed result chip', () => {
    const summary = resultSummary(
      'ask_user_question',
      { content: 'ignored', isError: false },
      {
        kind: 'ask_user_question',
        decision: 'answered',
        decisionLabel: 'Answered',
        decisionTone: 'ok',
        remember: false,
        answers: [],
        createdAt: '2026-04-24T08:00:00.000Z',
        resolvedAt: '2026-04-24T08:00:05.000Z',
      },
    );

    expect(summary).toEqual({ text: 'Answered', tone: 'ok' });
  });
});
