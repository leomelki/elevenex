import {
  hasStartedAgentConversation,
  sessionAgentProvider,
  type SessionProviderColumns,
} from './session-provider.js';

describe('persisted session provider identity', () => {
  it.each([
    ['claude', { claudeSessionId: 'claude-thread' }],
    ['codex', { codexSessionId: 'codex-thread' }],
    ['pi', { piSessionPath: '/sessions/pi.jsonl' }],
    ['opencode', { opencodeSessionId: 'opencode-thread' }],
  ] satisfies readonly (readonly [string, SessionProviderColumns])[])(
    'recovers the legacy %s provider without touching its history',
    (provider, identity) => {
      expect(hasStartedAgentConversation(identity)).toBe(true);
      expect(
        sessionAgentProvider({ activeAgentProvider: 'claude', ...identity }),
      ).toBe(provider);
    },
  );
  it('keeps explicit choices and treats empty/placeholders as unstarted', () => {
    expect(
      sessionAgentProvider({
        activeAgentProvider: 'pi',
        codexSessionId: 'old-thread',
      }),
    ).toBe('pi');
    expect(
      sessionAgentProvider({
        activeAgentProvider: 'claude',
        claudeSessionId: 'chosen',
        codexSessionId: 'old',
      }),
    ).toBe('claude');
    expect(
      hasStartedAgentConversation({
        claudeSessionId: '-1',
        codexSessionId: null,
        piSessionPath: ' ',
        opencodeSessionId: '',
      }),
    ).toBe(false);
    expect(sessionAgentProvider({})).toBe('claude');
  });
});
