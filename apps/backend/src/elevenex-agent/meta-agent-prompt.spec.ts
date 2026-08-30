import {
  buildMetaAgentPrompt,
  permissionModeForAutonomy,
  normalizeAutonomyMode,
  ELEVENEX_META_AGENT_SYSTEM_PROMPT,
} from './meta-agent-prompt.js';

describe('meta-agent-prompt', () => {
  describe('buildMetaAgentPrompt', () => {
    it('substitutes every autonomy marker (no {{...}} left)', () => {
      for (const mode of ['full', 'review', 'plan'] as const) {
        const prompt = buildMetaAgentPrompt(mode);
        expect(prompt).not.toMatch(/\{\{[^}]+\}\}/);
      }
    });

    it('injects the review mandate by default', () => {
      const prompt = buildMetaAgentPrompt('review');
      expect(prompt).toContain('Review destructive');
      expect(prompt).toContain('request_approval BEFORE any risky');
      // The plan clause is empty in review mode.
      expect(prompt).not.toContain('You are in PLAN mode');
    });

    it('injects the plan-mode clause and mandate in plan mode', () => {
      const prompt = buildMetaAgentPrompt('plan');
      expect(prompt).toContain('Plan first');
      expect(prompt).toContain('You are in PLAN mode');
      expect(prompt).toContain('STOP');
    });

    it('injects the full-autonomy mandate in full mode', () => {
      const prompt = buildMetaAgentPrompt('full');
      expect(prompt).toContain('Full autonomy');
      expect(prompt).toContain('Act end-to-end');
    });

    it('falls back to review for unknown/null modes', () => {
      expect(buildMetaAgentPrompt(null)).toContain('Review destructive');
      expect(buildMetaAgentPrompt('bogus')).toContain('Review destructive');
    });

    it('always keeps the meta-agent identity header', () => {
      expect(ELEVENEX_META_AGENT_SYSTEM_PROMPT).toContain(
        '# You are the Elevenex Agent',
      );
      expect(buildMetaAgentPrompt('review')).toContain(
        '# You are the Elevenex Agent',
      );
    });
  });

  describe('permissionModeForAutonomy', () => {
    it('maps full → bypassPermissions, no plan mode', () => {
      expect(permissionModeForAutonomy('full')).toEqual({
        permissionMode: 'bypassPermissions',
        planMode: false,
      });
    });

    it('maps review → auto, no plan mode', () => {
      expect(permissionModeForAutonomy('review')).toEqual({
        permissionMode: 'auto',
        planMode: false,
      });
    });

    it('maps plan → auto + plan mode', () => {
      expect(permissionModeForAutonomy('plan')).toEqual({
        permissionMode: 'auto',
        planMode: true,
      });
    });

    it('defaults unknown modes to review behavior', () => {
      expect(permissionModeForAutonomy(undefined)).toEqual({
        permissionMode: 'auto',
        planMode: false,
      });
    });
  });

  describe('normalizeAutonomyMode', () => {
    it('passes through valid modes', () => {
      expect(normalizeAutonomyMode('full')).toBe('full');
      expect(normalizeAutonomyMode('review')).toBe('review');
      expect(normalizeAutonomyMode('plan')).toBe('plan');
    });

    it('defaults null/unknown to review', () => {
      expect(normalizeAutonomyMode(null)).toBe('review');
      expect(normalizeAutonomyMode(undefined)).toBe('review');
      expect(normalizeAutonomyMode('nope')).toBe('review');
    });
  });
});
