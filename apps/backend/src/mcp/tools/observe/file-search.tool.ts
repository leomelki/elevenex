import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveWorktreeScope } from './_resolve-scope.js';

/**
 * file_search — fuzzy filename lookup inside one worktree. 🟡scoped: a non-empty
 * query is required and results are capped. Returns compact path/name rows to
 * locate a file before opening it with read_file.
 */
export const fileSearchTool = defineTool({
  name: 'file_search',
  title: 'Find files by name',
  costClass: 'scoped',
  paginated: true,
  requiresQuery: true,
  description:
    'Fuzzy-find files by name/path in a worktree, scoped by sessionId or worktreePath. 🟡scoped, capped. Returns compact {path,name}. Next: read_file to open one, or text_search to grep contents.',
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
      .describe('Fuzzy filename/path query. Must be non-empty.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe('Max files to return (1-100). Default 30.'),
  },
  handler: async (args, ctx) => {
    const { worktreePath } = await resolveWorktreeScope(ctx, args);

    const results = await ctx.services.files.searchFiles(
      worktreePath,
      args.query,
      args.limit,
    );

    const truncated = results.length >= args.limit;

    return {
      data: {
        query: args.query,
        count: results.length,
        files: results.map((f) => ({ path: f.path, name: f.name })),
      },
      truncated,
      nextStep: truncated
        ? 'Hit the cap: refine the query for fewer, better matches.'
        : 'Open one with read_file, or text_search to grep contents.',
    };
  },
});
