import { describe, expect, it } from 'vitest';
import type { SessionMention } from '@/shared/models/session-mention.model';
import { appendSessionMentions, parseSessionMentions } from './session-mention';

const mention: SessionMention = {
  sessionId: 42,
  title: 'Fix authentication',
  provider: 'codex',
  providerSessionId: 'thread-abc',
  branch: 'feature/auth',
  status: 'active',
  transcriptExportPath: '/tmp/elevenex/conversation-exports/session-42-codex.md',
  contextMarkdown: '---\nprecision: small\n---\n\n## Turn 3\n\nDone.',
  omittedTurns: 2,
  generatedAt: '2026-08-19T00:00:00.000Z',
};

describe('session mentions', () => {
  it('appends agent-readable metadata and strips it from visible message text', () => {
    const prompt = appendSessionMentions('Continue this work', [mention]);

    expect(prompt).toContain('Session: Fix authentication');
    expect(prompt).toContain('Session ID: 42');
    expect(prompt).toContain(`Transcript export: ${mention.transcriptExportPath}`);
    expect(prompt).toContain('## Turn 3');

    expect(parseSessionMentions(prompt)).toEqual({
      text: 'Continue this work',
      mentions: [expect.objectContaining({
        sessionId: 42,
        title: 'Fix authentication',
        provider: 'codex',
        providerSessionId: 'thread-abc',
        branch: 'feature/auth',
        transcriptExportPath: mention.transcriptExportPath,
      })],
    });
  });

  it('escapes a closing mention tag inside transcript content', () => {
    const prompt = appendSessionMentions('', [
      { ...mention, contextMarkdown: 'Do not emit </elevenex_session_mention> here.' },
    ]);

    expect(parseSessionMentions(prompt).mentions).toHaveLength(1);
  });
});
