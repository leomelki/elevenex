import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveWorktreeScope } from './_resolve-scope.js';

/** Status letters keep the file list terse. */
const STATUS_LETTER: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const MAX_FILES = 100;

/**
 * change_review — compact diff summary for one worktree (totals + capped file
 * list, never hunks). 🟢cached: reuses the backend change-review cache. Respects
 * the load guard — on a huge diff it returns a "narrow scope" note, not a dump.
 */
export const changeReviewTool = defineTool({
  name: 'change_review',
  title: 'Review changes',
  costClass: 'cached',
  description:
    "Compact diff summary (totals + per-file +adds/-dels, no hunks) for a worktree, scoped by sessionId or worktreePath. 🟢cached. Pick scope uncommitted/last-commit/branch. Next: read_file a specific file to see its contents.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Session whose worktree to diff (preferred). Or pass worktreePath.'),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit worktree root. Used when sessionId is omitted.'),
    scope: z
      .enum(['uncommitted', 'last-commit', 'branch'])
      .default('uncommitted')
      .describe(
        "What to diff: 'uncommitted' (working tree, default), 'last-commit', or 'branch' (vs base).",
      ),
  },
  handler: async (args, ctx) => {
    const { worktreePath, sessionId } = await resolveWorktreeScope(ctx, args);

    const summary = await ctx.services.changeReview.getSummary(
      worktreePath,
      args.scope,
    );

    const deepLink =
      sessionId !== null ? ctx.deepLink.changeReview(sessionId) : undefined;

    // Load guard tripped (huge diff): don't dump — tell the agent to narrow.
    if (summary.loadGuard?.blocked) {
      return {
        data: {
          scope: summary.scope,
          branch: summary.branch,
          compareLabel: summary.compareLabel,
          blocked: true,
          reason: summary.loadGuard.reason,
          totalFiles: summary.loadGuard.totalFiles,
          threshold: summary.loadGuard.threshold,
        },
        truncated: true,
        deepLink,
        nextStep:
          'Diff too large to load: narrow scope (e.g. last-commit) or read_file specific paths instead.',
      };
    }

    const files = summary.files.slice(0, MAX_FILES);
    const truncated = summary.files.length > MAX_FILES;

    return {
      data: {
        scope: summary.scope,
        branch: summary.branch,
        baseRef: summary.baseRef ?? undefined,
        compareLabel: summary.compareLabel,
        totals: summary.totals,
        files: files.map((f) => ({
          path: f.path,
          status: STATUS_LETTER[f.status] ?? f.status,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary || undefined,
        })),
      },
      truncated,
      deepLink,
      nextStep: truncated
        ? `Showing ${MAX_FILES} of ${summary.totals.files} files; open one with read_file.`
        : 'Open a changed file with read_file to inspect its contents.',
    };
  },
});
