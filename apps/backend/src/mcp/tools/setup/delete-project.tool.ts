import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * delete_project — permanently remove a project and all associated data
 * (repos, worktrees, sessions) from the database. ⚡instant. Irreversible.
 */
export const deleteProjectTool = defineTool({
  name: 'delete_project',
  title: 'Delete project',
  costClass: 'instant',
  mutates: true,
  destructive: true,
  description:
    'Permanently delete a project and all associated data (repos, worktrees, sessions). This is irreversible — use archive instead if you want to preserve history. ⚡instant.',
  inputShape: {
    projectId: z
      .number()
      .int()
      .positive()
      .describe('ID of the project to permanently delete.'),
  },
  handler: async (args, ctx) => {
    const { projects, sessions } = ctx.services;

    let project: { id: number; name: string };
    try {
      project = await projects.findOne(args.projectId);
    } catch {
      throw new ToolError({
        code: 'project_not_found',
        message: `No project found with id ${args.projectId}.`,
        remediation: 'Check the projectId via list_projects or project_overview.',
      });
    }

    // Stop any running sessions before the DB cascade removes their records.
    await sessions.archiveAllByProject(args.projectId).catch(() => {
      // Best-effort — proceed with deletion even if session cleanup partially fails.
    });

    try {
      await projects.delete(args.projectId);
    } catch (error) {
      throw new ToolError({
        code: 'delete_project_failed',
        message: error instanceof Error ? error.message : 'Could not delete project.',
        remediation: 'Verify the projectId is correct and try again.',
      });
    }

    return {
      data: { projectId: args.projectId, name: project.name, deleted: true },
      touched: { projectId: args.projectId },
      nextStep: 'Confirm deletion with list_projects.',
    };
  },
});
