import { resolveWorktreeScope } from '../observe/_resolve-scope.js';
import { z } from 'zod';
import { DEFAULT_AGENT_PROVIDERS } from '../../../settings/settings.types.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * generate_worktree_context : ðŸ”´heavy, mutates. Runs git analysis + an LLM to
 * produce/refresh the one-line "what this branch is doing" context for a
 * worktree, then persists it. The backend coalesces concurrent calls. Returns
 * the resulting snapshot (contextSentence + generationStatus).
 */
export const generateWorktreeContextTool = defineTool({
  name: 'generate_worktree_context',
  title: 'Generate worktree context',
  costClass: 'heavy',
  mutates: true,
  description:
    "Generate/refresh a worktree's one-line context sentence (git diff analysis + LLM) and persist it. Expensive: may take seconds; the backend coalesces concurrent calls. Returns generationStatus + contextSentence. Pass force to regenerate a cached one.",
  currentSessionScope: 'worktree',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Session whose active task checkout to summarize. Defaults to the caller; explicit repoId+worktreePath also works.',
      ),
    repoId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Required with an explicit worktreePath when sessionId is omitted.',
      ),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Explicit active checkout root; otherwise resolved from sessionId.',
      ),
    force: z
      .boolean()
      .default(false)
      .describe('Regenerate even if a cached sentence exists. Default false.'),
    provider: z
      .enum(DEFAULT_AGENT_PROVIDERS)
      .optional()
      .describe(
        'LLM provider; defaults to the scoped session’s active provider, or claude for an explicit checkout.',
      ),
  },
  handler: async (args, ctx) => {
    const { worktreeContext } = ctx.services;
    const { worktreePath, repoId, sessionId } = await resolveWorktreeScope(
      ctx,
      args,
    );
    if (repoId === null)
      throw new ToolError({
        code: 'repo_required',
        message: 'Pass sessionId or repoId+worktreePath.',
        remediation: 'Use get_current_session for checkout identity.',
      });
    const provider =
      args.provider ??
      (sessionId === null
        ? 'claude'
        : (await ctx.services.sessions.findOne(sessionId)).activeAgentProvider);
    let snapshot;
    try {
      snapshot = await worktreeContext.generate(repoId, worktreePath, {
        force: args.force,
        provider,
      });
    } catch (error) {
      throw new ToolError({
        code: 'context_generation_failed',
        message:
          error instanceof Error ? error.message : 'Context generation failed.',
        remediation:
          'Verify the repoId and worktreePath, and that the worktree has changes to summarize.',
        retryable: true,
      });
    }

    return {
      data: {
        repoId: snapshot.repoId,
        worktreePath: snapshot.worktreePath,
        generationStatus: snapshot.generationStatus,
        contextSentence: snapshot.contextSentence ?? undefined,
        hasChanges: snapshot.hasChanges,
        generatedAt: snapshot.generatedAt ?? undefined,
        error: snapshot.errorMessage ?? undefined,
      },
      nextStep:
        snapshot.generationStatus === 'ready'
          ? 'Context ready : use it when creating or prompting a session.'
          : snapshot.generationStatus === 'failed'
            ? 'Generation failed : inspect error and retry with force:true.'
            : !snapshot.hasChanges
              ? 'No branch-specific changes to summarize. Continue with native coding tools; no repeated generation is needed.'
              : 'Use get_worktree_context to inspect the cached generation state.',
    };
  },
});
