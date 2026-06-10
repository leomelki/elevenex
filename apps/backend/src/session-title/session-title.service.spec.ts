import { SessionTitleService } from './session-title.service.js';
import { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';

describe('SessionTitleService', () => {
  let service: SessionTitleService;
  let textAgentGenerationService: {
    generate: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    textAgentGenerationService = {
      generate: jest.fn(),
    };
    service = new SessionTitleService(
      textAgentGenerationService as unknown as TextAgentGenerationService,
    );
  });

  it('generates a one-turn text-only title without tools', async () => {
    textAgentGenerationService.generate.mockResolvedValue({
      provider: 'claude',
      model: 'haiku',
      text: 'Implement Auto Names',
    });

    const title = await service.generate(
      '/tmp/project',
      'Please implement auto names',
      'claude',
    );

    expect(title).toBe('Implement Auto Names');
    expect(textAgentGenerationService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        worktreePath: '/tmp/project',
        taskName: 'session-title',
        claude: expect.objectContaining({
          maxTurns: 1,
          persistSession: false,
          settingSources: ['project', 'user', 'local'],
          allowedTools: [],
        }),
      }),
    );
    expect(
      textAgentGenerationService.generate.mock.calls[0][0].prompt,
    ).not.toEqual(expect.any(String));
  });

  it('uses Codex for Codex session titles', async () => {
    textAgentGenerationService.generate.mockResolvedValue({
      provider: 'codex',
      model: 'gpt-5.4-mini',
      text: 'Implement Auto Names',
    });

    const title = await service.generate(
      '/tmp/project',
      'Please implement auto names',
      'codex',
    );

    expect(title).toBe('Implement Auto Names');
    expect(textAgentGenerationService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        prompt: expect.stringContaining('Please implement auto names'),
      }),
    );
  });

  it('normalizes generated titles to five words without markdown or punctuation', async () => {
    textAgentGenerationService.generate.mockResolvedValue({
      provider: 'claude',
      model: 'haiku',
      text: '```text\n"Implement Auto Session Names Quickly Now Please!"\n```',
    });

    await expect(
      service.generate('/tmp/project', 'Please implement auto names', 'claude'),
    ).resolves.toBe('Implement Auto Session Names Quickly');
  });
});
