import { z } from 'zod';
import { DEFAULT_AGENT_PROVIDERS } from '../../../settings/settings.types.js';
import { defineTool } from '../../tool-registry/tool.types.js';
import { taskOperation } from './task.util.js';

export const createSessionTool = defineTool({
  name: 'create_session',
  title: 'Create task conversation',
  costClass: 'scoped',
  mutates: true,
  currentSessionScope: 'task',
  description:
    'Create an additional coding conversation in a ready task using its current checkout. Does not start an agent. Conversations in the same task share files; create_task for isolated parallel work, open_task_session to reuse an existing conversation. Uses the configured default provider when omitted.',
  inputShape: {
    taskId: z
      .number()
      .int()
      .positive()
      .describe(
        'Ready task ID from get_current_session, get_task, or list_tasks. Repo and checkout are resolved from the task.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .optional()
      .describe('Optional conversation name; generated when omitted.'),
    provider: z
      .enum(DEFAULT_AGENT_PROVIDERS)
      .optional()
      .describe(
        'Agent provider; omitted uses the configured Elevenex default.',
      ),
    folderId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional session folder in the same task, from list_session_folders.',
      ),
  },
  handler: async (args, ctx) => {
    const task = await taskOperation(() =>
      ctx.services.tasks.record(args.taskId),
    );
    const session = await taskOperation(() =>
      ctx.services.sessions.create({
        repoId: task.repoId,
        workspaceId: task.id,
        name: args.name,
        folderId: args.folderId,
        surface: 'session',
        activeAgentProvider: args.provider,
      }),
    );
    return {
      data: {
        taskId: task.id,
        sessionId: session.id,
        name: session.name,
        repoId: session.repoId,
        branch: session.branchName,
        worktreePath: session.worktreePath,
        provider: session.activeAgentProvider,
        status: session.status,
      },
      touched: { sessionId: session.id },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        'prompt_session to start work. Coordinate writes with other conversations in this task; their worktree is shared.',
    };
  },
});
