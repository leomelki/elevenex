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
    'Find a project by exact name, or create it if missing (idempotent, so resumed missions never duplicate). ⚡instant. Returns the project handle with a created flag. Next: add_repo to attach a repository.',
  annotations: { idempotentHint: true },
  inputShape: {
    name: z
      .string()
      .min(1)
      .describe('Exact project name to find or create (unique). Trimmed.'),
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
