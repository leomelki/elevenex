import { describe, expect, it } from 'vitest';
import { describeTool, resultSummary } from './tool-format';

describe('tool-format', () => {
  it('shows Codex parsed read actions as Read tool calls', () => {
    const display = describeTool('Bash', {
      command: "sed -n '12,20p' Cargo.toml",
      commandActions: [
        {
          type: 'read',
          command: "sed -n '12,20p' Cargo.toml",
          name: 'Cargo.toml',
          path: '/repo/Cargo.toml',
        },
      ],
    });

    expect(display).toMatchObject({
      kind: 'read',
      verb: 'Read',
      target: '/repo/Cargo.toml',
    });
  });

  it('uses snake-case Codex parsed actions from app-server items', () => {
    const display = describeTool('Bash', {
      command: "/bin/zsh -lc \"sed -n '1,10p' apps/frontend/src/main.ts\"",
      command_actions: [
        {
          type: 'read',
          command: "sed -n '1,10p' apps/frontend/src/main.ts",
          name: 'main.ts',
          path: '/repo/apps/frontend/src/main.ts',
        },
      ],
    });

    expect(display).toMatchObject({
      kind: 'read',
      verb: 'Read',
      target: '…/frontend/src/main.ts',
    });
  });

  it('uses Codex pipeline parsing rather than local sed detection', () => {
    const display = describeTool('Bash', {
      command: "nl -ba core/src/parse_command.rs | sed -n '1200,1720p'",
      commandActions: [
        {
          type: 'read',
          command: "nl -ba core/src/parse_command.rs | sed -n '1200,1720p'",
          name: 'parse_command.rs',
          path: '/repo/core/src/parse_command.rs',
        },
      ],
    });

    expect(display).toMatchObject({
      kind: 'read',
      verb: 'Read',
      target: '…/core/src/parse_command.rs',
    });
  });

  it('keeps commands without Codex read actions as run tool calls', () => {
    expect(describeTool('Bash', { command: 'sed -n +10p file.txt' })).toMatchObject({
      kind: 'bash',
      verb: 'Run',
    });
    expect(describeTool('Bash', { command: 'sed -n 1,5p file.txt > out.txt' })).toMatchObject({
      kind: 'bash',
      verb: 'Run',
    });
    expect(describeTool('Bash', { command: 'cat file.txt' })).toMatchObject({
      kind: 'bash',
      verb: 'Run',
    });
  });

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
