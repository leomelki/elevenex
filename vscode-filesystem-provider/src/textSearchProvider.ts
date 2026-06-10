import { Range, Uri } from 'vscode';
import { BackendClient } from './backendClient';
import {
  BackendTextSearchOptions,
  BackendTextSearchResult,
} from './types';

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

function toWorkspaceVfsUri(worktreePath: string, relativePath: string): Uri {
  return Uri.from({
    scheme: 'workspace-vfs',
    authority: encodeURIComponent(worktreePath),
    path: `/${relativePath.replace(/\\/g, '/').replace(/^\/+/, '')}`,
  });
}

export function toVSCodeTextSearchResult(
  worktreePath: string,
  result: BackendTextSearchResult,
) {
  const ranges = result.ranges.map(
    (range) =>
      new Range(result.lineNumber, range.start, result.lineNumber, range.end),
  );
  const previewRanges = result.ranges.map(
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

        const results = await backendClient.searchText(
          worktreePath,
          request,
          abortController.signal,
        );

        if (token.isCancellationRequested) {
          return { limitHit: false };
        }

        for (const result of results) {
          progress.report(toVSCodeTextSearchResult(worktreePath, result));
        }

        return {
          limitHit:
            typeof options.maxResults === 'number' &&
            results.length >= options.maxResults,
        };
      } finally {
        cancellation?.dispose();
      }
    },
  };
}
