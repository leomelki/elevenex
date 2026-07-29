import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * find_or_create_project — idempotent project bootstrap by exact name. ⚡instant.
 * Reuses an existing project of the same name (created:false) or creates one
 * (created:true) so resumed missions never duplicate. Next: add_repo.
 */
export const findOrCreateProjectTool = defineTool({
  name: 'find_or_create_project',
  title: 'Find or create project',
  costClass: 'instant',
  mutates: true,
  description:
    'Find a project by exact name, or create it if missing (idempotent, so resumed missions never duplicate). ⚡instant. Returns the project handle with a created flag. Next: add_repo to attach a repository. ' +
    'Matching is exact-name, so before inventing one, call project_overview and look at this user\'s existing project names to infer their convention: do they run one project per repo (or fixed repo combo), reused across many tasks — or one project per feature/task? Follow whichever pattern is already established for this user, even if it differs from the default below. ' +
    'If there is no established pattern yet (e.g. this is the first project), default to naming after what the project durably represents — the repo, or the repo combination it holds — NOT the current feature/task, since a task-named project (e.g. "fix-login-timeout") will never be found again next time you work in the same repo, leaving one throwaway project per task instead of one reusable project per repo. For a single-repo project, prefer that repo\'s own name (e.g. "dd-source"). Use a feature/task name only when the project genuinely represents a fixed multi-repo combination assembled for that task and reuse across other tasks is not expected.',
  annotations: { idempotentHint: true },
  inputShape: {
    name: z
      .string()
      .min(1)
      .describe(
        'Exact project name to find or create (unique). Trimmed. ' +
        'Check project_overview first to match this user\'s established naming convention (per-repo vs per-feature). Absent a pattern, prefer the repo name for single-repo projects; avoid feature/task-specific names so the same project gets reused across tasks in that repo.',
      ),
  },
  handler: async (args, ctx) => {
    const { projects } = ctx.services;
    const name = args.name.trim();
    if (!name) {
      throw new ToolError({
        code: 'invalid_name',
        message: 'Project name is required.',
        remediation: 'Pass a non-empty name.',
      });
    }

    const existing = (await projects.findAll('all')).find((p) => p.name === name);
    const project = existing ?? (await projects.create(name));
    const created = !existing;

    return {
      data: { projectId: project.id, name: project.name, created },
      touched: { projectId: project.id },
      deepLink: ctx.deepLink.project(project.id),
      nextStep: 'Attach a repository with add_repo.',
    };
  },
});
