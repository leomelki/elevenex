import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * generate_worktree_context — 🔴heavy, mutates. Runs git analysis + an LLM to
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
    "Generate/refresh a worktree's one-line context sentence (git diff analysis + LLM) and persist it. 🔴heavy — may take seconds; the backend coalesces concurrent calls. Returns generationStatus + contextSentence. Pass force to regenerate a cached one.",
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo the worktree belongs to.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute path of the worktree to summarize.'),
    force: z
      .boolean()
      .default(false)
      .describe('Regenerate even if a cached sentence exists. Default false.'),
    provider: z
      .enum(['claude', 'codex'])
      .default('claude')
      .describe("LLM provider for generation. Default 'claude'."),
  },
  handler: async (args, ctx) => {
    const { worktreeContext } = ctx.services;
    let snapshot;
    try {
      snapshot = await worktreeContext.generate(args.repoId, args.worktreePath, {
        force: args.force,
        provider: args.provider,
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
          ? 'Context ready — use it when creating or prompting a session.'
          : snapshot.generationStatus === 'failed'
            ? 'Generation failed — inspect error and retry with force:true.'
            : 'Still generating — re-call to get the latest snapshot.',
    };
  },
});
