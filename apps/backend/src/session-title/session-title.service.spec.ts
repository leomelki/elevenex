jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnvAsync: jest.fn(() =>
    Promise.resolve({
      PATH: '/mock/bin',
      HOME: '/home/test-user',
    }),
  ),
  findBinary: jest.fn((name: string) => {
    if (name === 'claude') return '/usr/bin/claude';
    if (name === '/custom/bin/claude') return '/custom/bin/claude';
    return null;
  }),
}));

import { buildAugmentedEnvAsync, findBinary } from '../config/system-paths.js';
import { SessionTitleService } from './session-title.service.js';

interface QueryPayload {
  prompt: string;
  options: {
    pathToClaudeCodeExecutable?: string;
    [key: string]: unknown;
  };
}

type RuntimeQuery = AsyncIterable<unknown> & {
  close: jest.Mock<void, []>;
};

interface SdkMock {
  query: jest.Mock<RuntimeQuery, [QueryPayload]>;
}

interface SessionTitleServiceInternals {
  loadClaudeSdk(): Promise<SdkMock | null>;
  normalize(rawTitle: string): string | null;
  resolveSdkClaudePath(): string | null;
}

function serviceInternals(
  service: SessionTitleService,
): SessionTitleServiceInternals {
  return service as unknown as SessionTitleServiceInternals;
}

function createRuntimeQuery(
  text: string,
  close: jest.Mock<void, []> = jest.fn<void, []>(),
): RuntimeQuery {
  return {
    close,
    [Symbol.asyncIterator]: () => {
      let emitted = false;
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          if (emitted) {
            return Promise.resolve({ done: true, value: undefined });
          }
          emitted = true;
          return Promise.resolve({
            done: false,
            value: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text }],
              },
            },
          });
        },
      };
    },
  };
}

describe('SessionTitleService', () => {
  let service: SessionTitleService;
  const originalClaudeBin = process.env.ELEVENEX_CLAUDE_BIN;

  beforeEach(() => {
    jest.clearAllMocks();
    if (originalClaudeBin === undefined) {
      delete process.env.ELEVENEX_CLAUDE_BIN;
    } else {
      process.env.ELEVENEX_CLAUDE_BIN = originalClaudeBin;
    }
    service = new SessionTitleService();
    jest
      .spyOn(serviceInternals(service), 'resolveSdkClaudePath')
      .mockReturnValue(null);
  });

  it('generates a one-turn text-only title without tools', async () => {
    const close = jest.fn<void, []>();
    const sdk: SdkMock = {
      query: jest
        .fn<RuntimeQuery, [QueryPayload]>()
        .mockReturnValue(createRuntimeQuery('Implement Auto Names', close)),
    };
    jest
      .spyOn(serviceInternals(service), 'loadClaudeSdk')
      .mockResolvedValue(sdk);

    const title = await service.generate(
      '/tmp/project',
      'Please implement auto names',
    );

    const firstQuery = sdk.query.mock.calls[0]?.[0];
    if (!firstQuery) {
      throw new Error('Expected Claude SDK query to be called');
    }

    expect(title).toBe('Implement Auto Names');
    expect(firstQuery.options).toMatchObject({
      cwd: '/tmp/project',
      model: 'haiku',
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      env: {
        PATH: '/mock/bin',
        HOME: '/home/test-user',
      },
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      systemPrompt:
        'You generate concise session titles. Reply with only the title.',
      tools: [],
    });
    expect(firstQuery.prompt).toContain(
      'Respond immediately with a broad short title',
    );
    expect(buildAugmentedEnvAsync).toHaveBeenCalledWith(
      process.env,
      '/tmp/project',
    );
    expect(close).toHaveBeenCalled();
  });

  it('honors ELEVENEX_CLAUDE_BIN before the SDK bundled binary', async () => {
    process.env.ELEVENEX_CLAUDE_BIN = '/custom/bin/claude';
    const close = jest.fn<void, []>();
    const sdk: SdkMock = {
      query: jest
        .fn<RuntimeQuery, [QueryPayload]>()
        .mockReturnValue(createRuntimeQuery('Custom Claude Title', close)),
    };
    jest
      .spyOn(serviceInternals(service), 'loadClaudeSdk')
      .mockResolvedValue(sdk);
    const sdkPathSpy = jest
      .spyOn(serviceInternals(service), 'resolveSdkClaudePath')
      .mockReturnValue('/sdk/claude');

    await service.generate('/tmp/project', 'Use custom claude');

    const firstQuery = sdk.query.mock.calls[0]?.[0];
    expect(firstQuery?.options.pathToClaudeCodeExecutable).toBe(
      '/custom/bin/claude',
    );
    expect(findBinary).toHaveBeenCalledWith('/custom/bin/claude');
    expect(sdkPathSpy).not.toHaveBeenCalled();
  });

  it('normalizes generated titles to five words without markdown or punctuation', () => {
    expect(
      serviceInternals(service).normalize(
        '```text\n"Implement Auto Session Names Quickly Now Please!"\n```',
      ),
    ).toBe('Implement Auto Session Names Quickly');
  });
});
