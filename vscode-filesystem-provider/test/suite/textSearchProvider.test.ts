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

    assert.strictEqual(
      result.uri.toString(),
      `workspace-vfs://${encodeURIComponent(worktreePath)}/src/app.ts`,
    );
    assert.deepStrictEqual(result.ranges, [new Range(3, 6, 3, 12)]);
    assert.deepStrictEqual(result.preview.matches, [new Range(0, 6, 0, 12)]);
    assert.strictEqual(result.preview.text, 'const needle = true;');
  });

  test('reports backend results and forwards search options', async () => {
    const calls: unknown[] = [];
    const backendClient = {
      searchText: async (...args: unknown[]) => {
        calls.push(args);
        return [
          {
            path: 'src/app.ts',
            lineNumber: 0,
            lineText: 'needle',
            ranges: [{ start: 0, end: 6 }],
          },
        ];
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

  test('returns without searching when already cancelled', async () => {
    const backendClient = {
      searchText: async () => {
        throw new Error('searchText should not be called');
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
