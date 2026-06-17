import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveWorktreeScope } from './_resolve-scope.js';

/** Hard cap on returned lines so a single read can never blow the token budget. */
const MAX_LINES = 400;

/**
 * read_file — open a file (or a line window) inside one worktree. 🟢 Prefer a
 * window (startLine/endLine) to save tokens; content is hard-capped and flagged
 * truncated when it overflows. Scope by sessionId or worktreePath.
 */
export const readFileTool = defineTool({
  name: 'read_file',
  title: 'Read a file',
  costClass: 'cached',
  description:
    'Read a file or a line window inside a worktree, scoped by sessionId or worktreePath. 🟢 Prefer a window to save tokens; capped at 400 lines. Reach here after text_search/file_search; narrow with startLine/endLine when truncated.',
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Session whose worktree the file lives in (preferred). Or pass worktreePath.'),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit worktree root. Used when sessionId is omitted.'),
    path: z
      .string()
      .min(1)
      .describe('File path relative to the worktree root (or absolute within it).'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-based first line to return. Omit for whole file, but prefer a window.'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-based last line (inclusive). Omit to read to EOF (still capped at 400 lines).'),
  },
  handler: async (args, ctx) => {
    const { worktreePath } = await resolveWorktreeScope(ctx, args);

    const absPath = path.isAbsolute(args.path)
      ? args.path
      : path.resolve(worktreePath, args.path);

    const { content, language } = await ctx.services.files.readFile(
      absPath,
      worktreePath,
    );

    const lines = content.split('\n');
    const totalLines = lines.length;

    // Resolve the requested window (1-based, inclusive), defaulting to whole file.
    const reqStart = Math.max(1, args.startLine ?? 1);
    const reqEnd = Math.min(totalLines, args.endLine ?? totalLines);

    let start = reqStart;
    let end = reqEnd < start ? start : reqEnd;
    let truncated = false;
    if (end - start + 1 > MAX_LINES) {
      end = start + MAX_LINES - 1;
      truncated = true;
    }

    const slice = lines.slice(start - 1, end).join('\n');

    return {
      data: {
        path: args.path,
        language,
        startLine: start,
        endLine: end,
        totalLines,
        content: slice,
      },
      truncated,
      nextStep: truncated
        ? `Capped at ${MAX_LINES} lines: re-read with startLine=${end + 1} to continue, or pass a tighter window.`
        : 'Use text_search to find related references, or read another file.',
    };
  },
});
