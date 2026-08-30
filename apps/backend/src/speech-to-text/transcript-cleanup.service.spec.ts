import { TranscriptCleanupService } from './transcript-cleanup.service.js';
import type { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';

function createService(generate: jest.Mock) {
  const textAgent = { generate } as unknown as TextAgentGenerationService;
  return new TranscriptCleanupService(textAgent);
}

const BASE = {
  provider: 'claude' as const,
  model: null,
  worktreePath: '/repo',
  keyterms: [] as string[],
};

describe('TranscriptCleanupService', () => {
  it('returns the cleaned text and asks for no tools', async () => {
    const generate = jest.fn(async () => ({
      provider: 'claude',
      model: 'haiku',
      text: 'fix the composer component',
    }));
    const service = createService(generate);

    await expect(
      service.clean({ ...BASE, rawText: 'um fix the composer component' }),
    ).resolves.toBe('fix the composer component');

    const request = generate.mock.calls[0]![0] as Record<string, any>;
    expect(request['taskName']).toBe('speech-cleanup');
    // A latency-critical text transform must not ship the full tool preset.
    expect(request['claude'].tools).toEqual([]);
    expect(request['claude'].maxTurns).toBe(1);
    expect(request['claude'].model).toBe('haiku');
  });

  it('passes the pinned model to every harness that accepts one', async () => {
    const generate = jest.fn(async () => ({
      provider: 'codex',
      model: 'gpt-5.4-mini',
      text: 'ok',
    }));
    const service = createService(generate);

    await service.clean({
      ...BASE,
      provider: 'codex',
      model: 'gpt-5.4-mini',
      rawText: 'ok',
    });

    const request = generate.mock.calls[0]![0] as Record<string, any>;
    expect(request['codex']).toEqual({ model: 'gpt-5.4-mini' });
  });

  it('includes keyterms so spoken identifiers can be reconstructed', async () => {
    const generate = jest.fn(async () => ({
      provider: 'claude',
      model: 'haiku',
      text: 'edit cw-composer.component.ts',
    }));
    const service = createService(generate);

    await service.clean({
      ...BASE,
      rawText: 'edit cw dash composer dot component dot ts',
      keyterms: ['cw-composer.component.ts'],
    });

    const prompt = (generate.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('cw-composer.component.ts');
  });

  // The whole point of returning null rather than throwing: the caller falls
  // back to the raw transcript, so dictated words survive any failure here.
  it('returns null when the harness throws', async () => {
    const service = createService(
      jest.fn(async () => {
        throw new Error('CLI not installed');
      }),
    );

    await expect(
      service.clean({ ...BASE, rawText: 'some words' }),
    ).resolves.toBeNull();
  });

  it('returns null when the harness returns nothing', async () => {
    const service = createService(jest.fn(async () => null));
    await expect(
      service.clean({ ...BASE, rawText: 'some words' }),
    ).resolves.toBeNull();
  });

  it('returns null on an empty reply', async () => {
    const service = createService(
      jest.fn(async () => ({ provider: 'claude', model: 'haiku', text: '   ' })),
    );
    await expect(
      service.clean({ ...BASE, rawText: 'some words' }),
    ).resolves.toBeNull();
  });

  it('rejects a reply that answered the message instead of cleaning it', async () => {
    const service = createService(
      jest.fn(async () => ({
        provider: 'claude',
        model: 'haiku',
        text: "Sure! I'll fix the composer for you. First I will open the file, then I will read through the component, then I will apply the change and run the tests to confirm everything passes.",
      })),
    );

    await expect(
      service.clean({ ...BASE, rawText: 'fix the composer' }),
    ).resolves.toBeNull();
  });

  it('strips a code fence or wrapping quotes from the reply', async () => {
    const fenced = createService(
      jest.fn(async () => ({
        provider: 'claude',
        model: 'haiku',
        text: '```\nfix the composer\n```',
      })),
    );
    await expect(
      fenced.clean({ ...BASE, rawText: 'um fix the composer' }),
    ).resolves.toBe('fix the composer');

    const quoted = createService(
      jest.fn(async () => ({
        provider: 'claude',
        model: 'haiku',
        text: '"fix the composer"',
      })),
    );
    await expect(
      quoted.clean({ ...BASE, rawText: 'um fix the composer' }),
    ).resolves.toBe('fix the composer');
  });

  it('skips empty and oversized transcripts without calling a model', async () => {
    const generate = jest.fn();
    const service = createService(generate);

    await expect(service.clean({ ...BASE, rawText: '   ' })).resolves.toBeNull();
    await expect(
      service.clean({ ...BASE, rawText: 'x'.repeat(5000) }),
    ).resolves.toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('gives up rather than hanging when the harness never resolves', async () => {
    jest.useFakeTimers();
    try {
      const service = createService(jest.fn(() => new Promise(() => {})));
      const pending = service.clean({ ...BASE, rawText: 'some words' });
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
