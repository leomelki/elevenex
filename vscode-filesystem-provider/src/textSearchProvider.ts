import { Range } from 'vscode';
import { BackendClient } from './backendClient';
import {
  BackendTextSearchOptions,
  BackendTextSearchResult,
} from './types';
import { toWorkspaceVfsUri } from './workspaceUri';

type CancellationTokenLike = {
  isCancellationRequested?: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose(): void };
};

type ProgressLike<T> = {
  report(value: T): void;
};

function normalizeGlobPattern(pattern: unknown): string | null {
  if (typeof pattern === 'string') {
    return pattern;
  }

  if (pattern && typeof pattern === 'object' && 'pattern' in pattern) {
    const value = (pattern as { pattern?: unknown }).pattern;
    return typeof value === 'string' ? value : null;
  }

  return null;
}

function normalizeGlobPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns
    .map(normalizeGlobPattern)
    .filter((pattern): pattern is string => Boolean(pattern));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function toVSCodeTextSearchResult(
  worktreePath: string,
  result: BackendTextSearchResult,
) {
  const ranges = result.ranges.map(
    (range) =>
      new Range(result.lineNumber, range.start, result.lineNumber, range.end),
  );
  // Preview offsets differ from document offsets when the backend windowed a
  // very long line.
  const previewRanges = (result.previewRanges ?? result.ranges).map(
    (range) => new Range(0, range.start, 0, range.end),
  );

  return {
    uri: toWorkspaceVfsUri(worktreePath, result.path),
    ranges,
    preview: {
      text: result.lineText,
      matches: previewRanges,
    },
  };
}

export function createWorkspaceTextSearchProvider(
  worktreePath: string,
  backendClient: BackendClient,
) {
  return {
    async provideTextSearchResults(
      query: {
        pattern: string;
        isRegExp?: boolean;
        isCaseSensitive?: boolean;
        isWordMatch?: boolean;
      },
      options: {
        includes?: unknown[];
        excludes?: unknown[];
        useIgnoreFiles?: boolean;
        maxResults?: number;
      },
      progress: ProgressLike<ReturnType<typeof toVSCodeTextSearchResult>>,
      token: CancellationTokenLike,
    ): Promise<{ limitHit: boolean }> {
      if (token.isCancellationRequested) {
        return { limitHit: false };
      }

      const abortController = new AbortController();
      const cancellation = token.onCancellationRequested?.(() => {
        abortController.abort();
      });

      try {
        const request: BackendTextSearchOptions = {
          query: query.pattern,
          isRegExp: query.isRegExp,
          isCaseSensitive: query.isCaseSensitive,
          isWordMatch: query.isWordMatch,
          includes: normalizeGlobPatterns(options.includes),
          excludes: normalizeGlobPatterns(options.excludes),
          useIgnoreFiles: options.useIgnoreFiles,
          maxResults: options.maxResults,
        };

        const summary = await backendClient.searchTextStream(
          worktreePath,
          request,
          (batch) => {
            if (token.isCancellationRequested) {
              return;
            }

            for (const result of batch) {
              progress.report(toVSCodeTextSearchResult(worktreePath, result));
            }
          },
          abortController.signal,
        );

        return { limitHit: summary.limitHit };
      } catch (error) {
        // A superseded search aborts its request; that is not a failure to
        // surface, and results already reported stay in the view.
        if (token.isCancellationRequested || isAbortError(error)) {
          return { limitHit: false };
        }

        throw error;
      } finally {
        cancellation?.dispose();
      }
    },
  };
}
