import { SessionTitleService } from './session-title.service.js';

describe('SessionTitleService', () => {
  let service: SessionTitleService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionTitleService();
  });

  it('generates a one-turn text-only title without tools', async () => {
    const close = jest.fn();
    const sdk = {
      query: jest.fn().mockImplementationOnce(() => ({
        close,
        [Symbol.asyncIterator]: () => {
          let emitted = false;
          return {
            next: async () => {
              if (emitted) {
                return { done: true, value: undefined };
              }
              emitted = true;
              return {
                done: false,
                value: {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: 'Implement Auto Names' }],
                  },
                },
              };
            },
          };
        },
      })),
    };
    jest.spyOn(service as any, 'loadClaudeSdk').mockResolvedValue(sdk);

    const title = await service.generate(
      '/tmp/project',
      'Please implement auto names',
    );

    expect(title).toBe('Implement Auto Names');
    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          cwd: '/tmp/project',
          model: 'haiku',
          maxTurns: 1,
          settingSources: [],
          allowedTools: [],
          systemPrompt:
            'You generate concise session titles. Reply with only the title.',
          tools: [],
        }),
      }),
    );
    expect(sdk.query.mock.calls[0][0].prompt).toContain(
      'Respond immediately with a broad short title',
    );
    expect(close).toHaveBeenCalled();
  });

  it('normalizes generated titles to five words without markdown or punctuation', () => {
    expect(
      (service as any).normalize(
        '```text\n"Implement Auto Session Names Quickly Now Please!"\n```',
      ),
    ).toBe('Implement Auto Session Names Quickly');
  });
});
