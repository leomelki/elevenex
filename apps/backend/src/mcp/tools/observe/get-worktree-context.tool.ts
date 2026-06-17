import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveWorktreeScope } from './_resolve-scope.js';

/**
 * get_worktree_context — the cached AI codebase summary for a worktree. 🟢cached:
 * returns whatever the backend already generated; it NEVER triggers (re)generation
 * (that's a separate, heavy setup tool). Quick orientation before diving in.
 */
export const getWorktreeContextTool = defineTool({
  name: 'get_worktree_context',
  title: 'Worktree context',
  costClass: 'cached',
  description:
    "Cached AI codebase summary for a worktree, scoped by sessionId or repoId+worktreePath. 🟢cached — returns only what's already generated, never regenerates (that's a heavy setup tool). Use to orient before text_search/read_file.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Session whose worktree context to read (preferred). Or pass repoId+worktreePath.'),
    repoId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Repo id. Required (with worktreePath) when sessionId is omitted.'),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe('Worktree root. Required (with repoId) when sessionId is omitted.'),
  },
  handler: async (args, ctx) => {
    const { worktreePath, repoId } = await resolveWorktreeScope(ctx, args);

    if (repoId === null) {
      throw new ToolError({
        code: 'repo_required',
        message: 'A repoId is required when scoping by worktreePath (omit it by passing sessionId).',
        remediation: 'Pass sessionId, or both repoId and worktreePath.',
      });
    }

    const snapshot = await ctx.services.worktreeContext.getCachedSnapshot(
      repoId,
      worktreePath,
    );

    return {
      data: {
        repoId: snapshot.repoId,
        contextSentence: snapshot.contextSentence ?? undefined,
        generationStatus: snapshot.generationStatus,
        generatedAt: snapshot.generatedAt ?? undefined,
        hasRecord: snapshot.hasRecord,
        contextEnabled: snapshot.contextEnabled,
        canGenerate: snapshot.canGenerate,
      },
      nextStep: snapshot.contextSentence
        ? 'Orient with this, then text_search / file_search to dig in.'
        : 'No cached summary yet; explore directly with file_search / text_search.',
    };
  },
});
