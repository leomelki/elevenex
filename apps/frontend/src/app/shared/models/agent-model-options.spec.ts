import { describe, expect, it } from 'vitest';
import { agentModelOptions } from './agent-model-options';

describe('account-backed model choices', () => {
  it('does not offer a Codex default or saved ID without discovered data', () => {
    expect(agentModelOptions(null, 'saved-model', 'codex')).toEqual([]);
    expect(
      agentModelOptions(
        {
          provider: 'codex',
          displayName: 'Codex',
          models: [],
          reasoningEfforts: [],
          providerDefaultModelId: null,
          supportsModelSelection: true,
        },
        'saved-model',
      ),
    ).toEqual([]);
  });

  it('preserves other providers’ default choice before discovery', () => {
    expect(agentModelOptions(null, '', 'claude')[0].label).toBe('Agent default');
  });
});
