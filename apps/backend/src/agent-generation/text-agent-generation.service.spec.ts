import { DEFAULT_TEXT_AGENT_MODELS } from './text-agent-generation.service.js';

describe('TextAgentGenerationService defaults', () => {
  it('uses a mini Codex model for lightweight agent generation', () => {
    expect(DEFAULT_TEXT_AGENT_MODELS.codex).toBe('gpt-5.4-mini');
  });
});
