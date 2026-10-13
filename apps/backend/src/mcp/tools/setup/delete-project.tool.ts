import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * delete_project — permanently remove a project and all associated data
 * (repos, worktrees, sessions) from the database. ⚡instant. Irreversible.
 */
export const deleteProjectTool = defineTool({
  name: 'delete_project',
  title: 'Delete project',
  costClass: 'heavy',
  mutates: true,
  destructive: true,
  disallowSelfTarget: 'project',
  description:
    'Permanently delete a project and its task/conversation history after stopping its session runtimes. Irreversible. Cannot delete the caller’s own project. Finish tasks instead to preserve history.',
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
        remediation: 'Check the projectId via project_overview.',
      });
    }

    // Stop any running sessions before the DB cascade removes their records.
    projects.assertTaskHistoryCanBeDeleted(args.projectId);
    await sessions.archiveAllByProject(args.projectId, true);
    ctx.signal.throwIfAborted();

    try {
      await projects.delete(args.projectId, { requireFinishedTasks: true });
    } catch (error) {
      throw new ToolError({
        code: 'delete_project_failed',
        message:
          error instanceof Error ? error.message : 'Could not delete project.',
        remediation: 'Verify the projectId is correct and try again.',
      });
    }

    return {
      data: { projectId: args.projectId, name: project.name, deleted: true },
      touched: { projectId: args.projectId },
      nextStep: 'Confirm deletion with project_overview.',
    };
  },
});
