import { setTimeout as delay } from 'node:timers/promises';
import {
  buildExportModel,
  renderMarkdown,
} from '../../agent-runtime/conversation-export.service.js';
import {
  GREP_LIMITS,
  searchSessionTranscript,
} from '../tools/observe/session-grep.js';

// Pure model/render tests do not need provider processes and databases.
jest.mock('../../sessions/sessions.service.js', () => ({
  SessionsService: class {},
}));
jest.mock('../../agent-runtime/agent-runtime-registry.service.js', () => ({
  AgentRuntimeRegistryService: class {},
}));

const renderOptions = {
  precision: 'full',
  includeChanges: false,
  includeIds: false,
} as const;
const options = {
  query: 'needle',
  isRegExp: false,
  caseSensitive: false,
  contextLines: 3,
  maxMatches: 50,
};
function model(content: string) {
  return buildExportModel([{ id: 'u1', kind: 'user', content }], {
    title: 'Test',
    sessionId: 1,
    provider: 'claude',
    branch: 'test',
    exportedAt: '',
  });
}
function search(
  content: string,
  overrides = {},
  signal = new AbortController().signal,
) {
  return searchSessionTranscript(
    model(content),
    renderOptions,
    { ...options, ...overrides },
    signal,
  );
}

describe('bounded transcript search', () => {
  it('preserves JS lookarounds/backreferences, case sensitivity and exact rendered line numbers/context', async () => {
    const transcript = model('Header\n\n\nNEEDLE needle\nnext\n\ntrailing\n\n');
    const result = await searchSessionTranscript(
      transcript,
      renderOptions,
      {
        ...options,
        query: '(?<=NEEDLE )([a-z]+)\\b(?=\\n|$)',
        isRegExp: true,
        caseSensitive: true,
      },
      new AbortController().signal,
    );
    const lines = renderMarkdown(transcript, renderOptions).split('\n');
    expect(result.totalLines).toBe(lines.length);
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(lines[match.lineNumber - 1]).toBe(match.line);
    expect(match.context).toBe(
      lines
        .slice(match.lineNumber - 4, match.lineNumber + 3)
        .map((line, index) => `${index === 3 ? '>>> ' : '    '}${line}`)
        .join('\n'),
    );
    expect(
      (
        await search('abc abc\nABC abc', {
          query: '(abc) \\1',
          isRegExp: true,
          caseSensitive: true,
        })
      ).matchCount,
    ).toBe(1);
  });

  it.each(['small', 'medium', 'full'] as const)(
    'keeps legacy rendered bytes and context across turn boundaries at %s precision',
    async (precision) => {
      const transcript = buildExportModel(
        [
          { id: 'p', kind: 'system', content: 'preamble needle' },
          { id: 'u1', kind: 'user', content: 'first needle\n\n\nextra' },
          { id: 'a1', kind: 'assistant', content: 'answer needle' },
          { id: 'u2', kind: 'user', content: 'second needle   \n' },
          { id: 'a2', kind: 'assistant', content: 'last needle\n\n' },
        ],
        {
          title: 'Test',
          sessionId: 1,
          provider: 'claude',
          branch: 'test',
          exportedAt: '',
        },
      );
      const blocks = [
        `---\nsession: "Test" (#1)\nprovider: claude\nbranch: test\nprecision: ${precision}\nincludeChanges: false\nincludeIds: false\nexportedAt: \n---`,
        ...(precision === 'full'
          ? ['## Preamble', '[system]\npreamble needle']
          : []),
        '## Turn 1\n\n### User\n\nfirst needle\n\n\nextra\n\n### Response\n\nanswer needle',
        '## Turn 2\n\n### User\n\nsecond needle\n\n### Response\n\nlast needle',
      ];
      // Independent oracle: the original join/normalize/trim renderer algorithm.
      const expected =
        blocks
          .join('\n\n')
          .replace(/\n{3,}/g, '\n\n')
          .trimEnd() + '\n';
      expect(renderMarkdown(transcript, { ...renderOptions, precision })).toBe(
        expected,
      );
      const result = await searchSessionTranscript(
        transcript,
        { ...renderOptions, precision },
        options,
        new AbortController().signal,
      );
      const lines = expected.split('\n');
      expect(result.totalLines).toBe(lines.length);
      expect(result.matches.map((match) => match.lineNumber)).toEqual(
        lines.flatMap((line, index) =>
          line.includes('needle') ? [index + 1] : [],
        ),
      );
      for (const match of result.matches) {
        const start = Math.max(0, match.lineNumber - 1 - options.contextLines);
        const end = Math.min(
          lines.length,
          match.lineNumber + options.contextLines,
        );
        expect(match.context).toBe(
          lines
            .slice(start, end)
            .map(
              (line, index) =>
                `${start + index + 1 === match.lineNumber ? '>>> ' : '    '}${line}`,
            )
            .join('\n'),
        );
      }
    },
  );

  it('bounds huge matching and context lines and aggregate output with explicit metadata', async () => {
    const result = await search(
      Array.from({ length: 50 }, () => `needle${'x'.repeat(20_000)}`).join(
        '\n',
      ),
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(
      result.matches.every(
        (match) => match.line.length <= GREP_LIMITS.lineCharacters,
      ),
    ).toBe(true);
    const characters = result.matches.reduce(
      (sum, match) => sum + match.line.length + match.context.length,
      0,
    );
    expect(characters).toBe(result.returnedCharacters);
    expect(characters).toBeLessThanOrEqual(GREP_LIMITS.outputCharacters);
    expect(result.truncated).toBe(true);
    expect(result.truncation).toMatchObject({
      lineLimit: true,
      outputLimit: true,
    });
  });

  it('only marks the match limit when an additional match exists', async () => {
    expect(
      (await search('needle', { maxMatches: 1 })).truncation.matchLimit,
    ).toBe(false);
    expect(
      (await search('needle\nneedle', { maxMatches: 1 })).truncation.matchLimit,
    ).toBe(true);
  });

  it('searches user and final text at small precision despite oversized omitted preamble, work and changes', async () => {
    const transcript = model('user needle');
    const omitted = 'x'.repeat(GREP_LIMITS.blockInputCharacters + 1);
    transcript.preamble = [{ id: 'init', kind: 'system', content: omitted }];
    const turn = transcript.turns[0];
    turn.finalResponse = {
      id: 'final',
      kind: 'assistant',
      content: 'final needle',
    };
    turn.steps = Array.from(
      { length: GREP_LIMITS.blockInputNodes + 1 },
      (_, index) => ({
        id: `result-${index}`,
        kind: 'tool_result',
        content: omitted,
      }),
    );
    turn.changes = {
      files: 1,
      additions: 1,
      deletions: 0,
      filesChanged: [
        {
          path: omitted,
          status: 'modified',
          additions: 1,
          deletions: 0,
          hunks: [],
        },
      ],
    };
    const result = await searchSessionTranscript(
      transcript,
      { ...renderOptions, precision: 'small' },
      options,
      new AbortController().signal,
    );
    expect(result.matches.map((match) => match.line)).toEqual([
      'user needle',
      'final needle',
    ]);
    expect(result.truncated).toBe(false);
    // The same large preamble is genuinely consumed at full precision.
    await expect(
      searchSessionTranscript(
        transcript,
        renderOptions,
        options,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'grep_input_limit' });
  });

  it('ignores medium-precision thinking/tool output and omitted change hunks/metadata', async () => {
    const transcript = model('user needle');
    const omitted = 'x'.repeat(GREP_LIMITS.blockInputCharacters + 1);
    transcript.preamble = [
      { id: 'thinking', kind: 'thinking', content: omitted },
    ];
    const turn = transcript.turns[0];
    turn.finalResponse = {
      id: 'final',
      kind: 'assistant',
      content: 'final needle',
    };
    turn.steps = [
      {
        id: 'call',
        kind: 'tool_use',
        toolUseId: 'call',
        toolName: 'Bash',
        toolInput: { command: 'echo done', ignored: omitted },
      },
      {
        id: 'result',
        kind: 'tool_result',
        toolUseId: 'call',
        content: omitted,
      },
    ];
    turn.changes = {
      files: 1,
      additions: 1,
      deletions: 0,
      capture: {
        root: omitted,
        complete: true,
        aliases: Array(GREP_LIMITS.blockInputNodes + 1).fill('ignored'),
      },
      filesChanged: [
        {
          path: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          hunks: [
            {
              id: 'hunk',
              toolName: 'Edit',
              label: 'change',
              oldString: omitted,
              newString: omitted,
              additions: 1,
              deletions: 0,
            },
          ],
        },
      ],
    };
    const result = await searchSessionTranscript(
      transcript,
      { ...renderOptions, precision: 'medium', includeChanges: true },
      options,
      new AbortController().signal,
    );
    expect(result.matches.map((match) => match.line)).toEqual([
      'user needle',
      'final needle',
    ]);
    expect(result.truncated).toBe(false);
    // A paired output becomes searchable at full precision and remains bounded.
    transcript.preamble = [];
    await expect(
      searchSessionTranscript(
        transcript,
        renderOptions,
        options,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'grep_input_limit' });
  });

  it('terminates pathological regex on a hard deadline while the event loop stays responsive', async () => {
    const pending = search(`${'a'.repeat(40)}!`, {
      query: '^(a+)+$',
      isRegExp: true,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'grep_timeout',
    });
    const started = Date.now();
    await delay(50);
    expect(Date.now() - started).toBeLessThan(2000);
    await rejection;
    // Capacity is released only after the stuck worker has been terminated.
    expect((await search('needle')).matchCount).toBe(1);
  }, 20_000);

  it('aborts an executing pathological regex promptly and releases worker capacity', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled search');
    const pending = search(
      `${'a'.repeat(40)}!`,
      { query: '^(a+)+$', isRegExp: true },
      controller.signal,
    );
    const rejection = expect(pending).rejects.toBe(reason);
    await delay(100);
    const started = Date.now();
    controller.abort(reason);
    await rejection;
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await search('needle')).matchCount).toBe(1);
  });

  it('rejects overload rather than spawning unbounded workers', async () => {
    const controller = new AbortController();
    const calls = [0, 1].map(() =>
      search(
        `${'a'.repeat(40)}!`,
        { query: '^(a+)+$', isRegExp: true },
        controller.signal,
      ),
    );
    const drained = Promise.allSettled(calls);
    await expect(search('needle')).rejects.toMatchObject({ code: 'grep_busy' });
    controller.abort();
    await drained;
  });

  it('rejects oversized render blocks explicitly and honors pre-aborted signals', async () => {
    await expect(
      search('x'.repeat(GREP_LIMITS.blockInputCharacters + 1)),
    ).rejects.toMatchObject({ code: 'grep_input_limit' });
    const transcript = model('needle');
    transcript.turns[0].steps.push({
      id: 'large-key',
      kind: 'tool_use',
      toolName: 'tool',
      toolInput: { ['x'.repeat(GREP_LIMITS.blockInputCharacters + 1)]: 1 },
    });
    await expect(
      searchSessionTranscript(
        transcript,
        renderOptions,
        options,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'grep_input_limit' });
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(search('needle', {}, controller.signal)).rejects.toThrow(
      'already cancelled',
    );
    await expect(
      search('needle', { query: '[', isRegExp: true }),
    ).rejects.toMatchObject({ code: 'invalid_regexp' });
  });
});
