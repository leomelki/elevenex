import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * set_todo — mutates. Add a project todo, or update an existing one's text /
 * completed flag (pass todoId). ⚡instant. Lightweight mission bookkeeping.
 */
export const setTodoTool = defineTool({
  name: 'set_todo',
  title: 'Set todo',
  costClass: 'instant',
  mutates: true,
  description:
    "Add a project todo, or update an existing one (pass todoId) to edit its text or mark it completed. ⚡instant. Lightweight mission bookkeeping on a project's todo list.",
  inputShape: {
    projectId: z
      .number()
      .int()
      .positive()
      .describe('Project the todo belongs to.'),
    text: z
      .string()
      .optional()
      .describe('Todo text. Required when creating; optional when updating.'),
    todoId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Existing todo to update. Omit to create a new one.'),
    completed: z
      .boolean()
      .optional()
      .describe('When updating, mark completed (true) or open (false).'),
  },
  handler: async (args, ctx) => {
    const { todos } = ctx.services;

    if (args.todoId !== undefined) {
      const patch: { text?: string; completed?: boolean } = {};
      if (args.text !== undefined) patch.text = args.text;
      if (args.completed !== undefined) patch.completed = args.completed;
      const updated = await todos.update(args.todoId, patch);
      return {
        data: {
          todoId: updated.id,
          text: updated.text,
          completed: updated.completed,
        },
        touched: { todoId: updated.id },
        deepLink: ctx.deepLink.project(args.projectId),
      };
    }

    const text = args.text?.trim();
    if (!text) {
      throw new ToolError({
        code: 'todo_text_required',
        message: 'text is required when creating a todo.',
        remediation: 'Pass text, or pass todoId to update an existing todo.',
      });
    }
    const created = await todos.create(args.projectId, text);
    return {
      data: { todoId: created.id, text: created.text, completed: created.completed },
      touched: { todoId: created.id },
      deepLink: ctx.deepLink.project(args.projectId),
    };
  },
});
