import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveWorktreeScope } from './_resolve-scope.js';

/**
 * text_search — bounded content search (ripgrep) inside one worktree. 🟡scoped:
 * a non-empty query is required and results are capped. Returns compact
 * path/line/lineText rows, never whole files — open one with read_file.
 */
export const textSearchTool = defineTool({
  name: 'text_search',
  title: 'Search file contents',
  costClass: 'scoped',
  paginated: true,
  requiresQuery: true,
  description:
    'Search file contents in a worktree (literal or regex), scoped by sessionId or worktreePath. 🟡scoped, capped. Returns compact path:line rows. Next: read_file to open a hit, or narrow with includes/excludes when truncated.',
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Session whose worktree to search (preferred). Or pass worktreePath.'),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit worktree root to search. Used when sessionId is omitted.'),
    query: z
      .string()
      .describe('Search text (literal by default; regex when isRegExp). Must be non-empty.'),
    isRegExp: z
      .boolean()
      .default(false)
      .describe('Treat query as a regular expression. Default false.'),
    isCaseSensitive: z
      .boolean()
      .default(false)
      .describe('Case-sensitive match. Default false.'),
    includes: z
      .array(z.string().min(1))
      .optional()
      .describe('Glob(s) to include, e.g. ["src/**/*.ts"]. Narrows scope to save tokens.'),
    excludes: z
      .array(z.string().min(1))
      .optional()
      .describe('Glob(s) to exclude, e.g. ["**/*.test.ts"].'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(40)
      .describe('Max matching rows to return (1-100). Default 40.'),
  },
  handler: async (args, ctx) => {
    const { worktreePath } = await resolveWorktreeScope(ctx, args);

    const results = await ctx.services.files.searchText(worktreePath, {
      query: args.query,
      isRegExp: args.isRegExp,
      isCaseSensitive: args.isCaseSensitive,
      includes: args.includes,
      excludes: args.excludes,
      maxResults: args.maxResults,
    });

    const truncated = results.length >= args.maxResults;

    return {
      data: {
        query: args.query,
        count: results.length,
        matches: results.map((r) => ({
          path: r.path,
          lineNumber: r.lineNumber,
          lineText:
            r.lineText.length > 200 ? `${r.lineText.slice(0, 200)}…` : r.lineText,
        })),
      },
      truncated,
      nextStep: truncated
        ? 'Hit the cap: narrow with includes/excludes or a tighter query, then re-search.'
        : 'Open a hit with read_file (pass startLine/endLine to window).',
    };
  },
});
