import * as assert from 'assert';
import { Range } from 'vscode';
import {
  createWorkspaceTextSearchProvider,
  toVSCodeTextSearchResult,
} from '../../src/textSearchProvider';

suite('TextSearchProvider', () => {
  const worktreePath = '/tmp/test-worktree';

  test('maps backend matches to VS Code text search results', () => {
    const result = toVSCodeTextSearchResult(worktreePath, {
      path: 'src/app.ts',
      lineNumber: 3,
      lineText: 'const needle = true;',
      ranges: [{ start: 6, end: 12 }],
    });

    assert.strictEqual(result.uri.authority, 'elevenex');
    assert.strictEqual(result.uri.path, '/src/app.ts');
    assert.strictEqual(
      new URLSearchParams(result.uri.query).get('worktreePath'),
      worktreePath,
    );
    assert.deepStrictEqual(result.ranges, [new Range(3, 6, 3, 12)]);
    assert.deepStrictEqual(result.preview.matches, [new Range(0, 6, 0, 12)]);
    assert.strictEqual(result.preview.text, 'const needle = true;');
  });

  test('reports backend results and forwards search options', async () => {
    const calls: unknown[] = [];
    const backendClient = {
      searchTextStream: async (...args: unknown[]) => {
        calls.push(args);
        const onResults = args[2] as (batch: unknown[]) => void;
        onResults([
          {
            path: 'src/app.ts',
            lineNumber: 0,
            lineText: 'needle',
            ranges: [{ start: 0, end: 6 }],
          },
        ]);
        return { limitHit: false };
      },
    };
    const provider = createWorkspaceTextSearchProvider(
      worktreePath,
      backendClient as any,
    );
    const reported: unknown[] = [];

    const complete = await provider.provideTextSearchResults(
      {
        pattern: 'needle',
        isRegExp: false,
        isCaseSensitive: true,
        isWordMatch: false,
      },
      {
        includes: ['src/**'],
        excludes: [{ pattern: '**/*.spec.ts' }],
        useIgnoreFiles: true,
        maxResults: 10,
      },
      { report: (value) => reported.push(value) },
      { isCancellationRequested: false },
    );

    assert.deepStrictEqual(complete, { limitHit: false });
    assert.strictEqual(reported.length, 1);
    assert.deepStrictEqual((calls[0] as unknown[])[1], {
      query: 'needle',
      isRegExp: false,
      isCaseSensitive: true,
      isWordMatch: false,
      includes: ['src/**'],
      excludes: ['**/*.spec.ts'],
      useIgnoreFiles: true,
      maxResults: 10,
    });
  });

  test('reports each batch as it streams in, before the search completes', async () => {
    const reported: unknown[] = [];
    let releaseSecondBatch: (() => void) | undefined;
    const secondBatchGate = new Promise<void>((resolve) => {
      releaseSecondBatch = resolve;
    });

    const backendClient = {
      searchTextStream: async (
        _worktreePath: string,
        _options: unknown,
        onResults: (batch: unknown[]) => void,
      ) => {
        onResults([
          {
            path: 'a.ts',
            lineNumber: 0,
            lineText: 'needle',
            ranges: [{ start: 0, end: 6 }],
          },
        ]);

        await secondBatchGate;

        onResults([
          {
            path: 'b.ts',
            lineNumber: 1,
            lineText: 'needle',
            ranges: [{ start: 0, end: 6 }],
          },
        ]);

        return { limitHit: true };
      },
    };
    const provider = createWorkspaceTextSearchProvider(
      worktreePath,
      backendClient as any,
    );

    const pending = provider.provideTextSearchResults(
      { pattern: 'needle' },
      {},
      { report: (value) => reported.push(value) },
      { isCancellationRequested: false },
    );

    // The first batch is visible while the backend is still streaming.
    await Promise.resolve();
    assert.strictEqual(reported.length, 1);

    releaseSecondBatch!();
    const complete = await pending;

    assert.strictEqual(reported.length, 2);
    assert.deepStrictEqual(complete, { limitHit: true });
  });

  test('swallows abort errors from a superseded search', async () => {
    const backendClient = {
      searchTextStream: async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    };
    const provider = createWorkspaceTextSearchProvider(
      worktreePath,
      backendClient as any,
    );

    const complete = await provider.provideTextSearchResults(
      { pattern: 'needle' },
      {},
      { report: () => undefined },
      { isCancellationRequested: false },
    );

    assert.deepStrictEqual(complete, { limitHit: false });
  });

  test('returns without searching when already cancelled', async () => {
    const backendClient = {
      searchTextStream: async () => {
        throw new Error('searchTextStream should not be called');
      },
    };
    const provider = createWorkspaceTextSearchProvider(
      worktreePath,
      backendClient as any,
    );

    const complete = await provider.provideTextSearchResults(
      { pattern: 'needle' },
      {},
      { report: () => undefined },
      { isCancellationRequested: true },
    );

    assert.deepStrictEqual(complete, { limitHit: false });
  });
});
