import { piThinkingLevels } from './pi-thinking-levels.js';

describe('Pi model thinking metadata', () => {
  it('uses Pi levels instead of the other harnesses’ generic efforts', () => {
    expect(piThinkingLevels({ reasoning: true })).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(piThinkingLevels({ reasoning: false })).toEqual([]);
  });
  it('honors disabled levels and explicit extended-level mappings', () => {
    expect(
      piThinkingLevels({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          xhigh: 'xhigh',
          max: 'max',
        },
      }),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(
      piThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: null },
      }),
    ).not.toContain('max');
  });
});
