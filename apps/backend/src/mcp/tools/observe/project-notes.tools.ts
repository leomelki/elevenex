import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

const projectId = z
  .number()
  .int()
  .positive()
  .describe('Project ID from get_current_session or project_overview.');
const page = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe('Max handles, 1-100; default 25.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Page offset, default 0.'),
};
export const PROJECT_NOTES_TOOLS = [
  defineTool({
    name: 'list_todos',
    title: 'List project todos',
    costClass: 'instant',
    paginated: true,
    currentSessionScope: 'project',
    annotations: { readOnlyHint: true },
    description:
      'Page a project’s lightweight checklist to find todoIds before set_todo. These are checklist items, separate from executable Tasks with branches and conversations.',
    inputShape: {
      projectId,
      ...page,
      state: z
        .enum(['open', 'completed', 'all'])
        .default('open')
        .describe('Checklist filter, default open.'),
    },
    handler: async (args, ctx) => {
      const page = await ctx.services.todos.listHandles(
        args.projectId,
        args.state,
        args.offset,
        args.limit,
      );
      return {
        data: {
          projectId: args.projectId,
          ...page,
        },
        truncated: page.nextOffset !== null,
        deepLink: ctx.deepLink.project(args.projectId),
        nextStep:
          'set_todo updates an existing todoId or adds a checklist item; create_task starts work in a checkout.',
      };
    },
  }),
  defineTool({
    name: 'list_scratchpad',
    title: 'List project notes',
    costClass: 'instant',
    paginated: true,
    currentSessionScope: 'project',
    annotations: { readOnlyHint: true },
    description:
      'Page project scratchpad section handles and content lengths, without dumping their content. read_scratchpad reads a window; set_scratchpad creates or updates a named section.',
    inputShape: { projectId, ...page },
    handler: async (args, ctx) => {
      const page = await ctx.services.scratchpad.listHandles(
        args.projectId,
        args.offset,
        args.limit,
      );
      return {
        data: {
          projectId: args.projectId,
          ...page,
        },
        truncated: page.nextOffset !== null,
        deepLink: ctx.deepLink.project(args.projectId),
      };
    },
  }),
  defineTool({
    name: 'read_scratchpad',
    title: 'Read project note',
    costClass: 'instant',
    currentSessionScope: 'project',
    annotations: { readOnlyHint: true },
    description:
      'Read a bounded character window of one project scratchpad section. Use list_scratchpad for sectionIds; preserve existing notes when updating with set_scratchpad.',
    inputShape: {
      projectId,
      sectionId: z
        .number()
        .int()
        .positive()
        .describe('Section ID from list_scratchpad.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Character offset, default 0.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(12000)
        .default(4000)
        .describe('Character window, 1-12000; default 4000.'),
    },
    handler: async (args, ctx) => {
      const section = await ctx.services.scratchpad.readWindow(
        args.projectId,
        args.sectionId,
        args.offset,
        args.limit,
      );
      if (!section)
        throw new ToolError({
          code: 'section_not_found',
          message: `No scratchpad section ${args.sectionId} in project ${args.projectId}.`,
          remediation: 'Use list_scratchpad for the intended project.',
        });
      const end = Math.min(section.totalCharacters, args.offset + args.limit);
      return {
        data: {
          ...section,
          nextOffset: end < section.totalCharacters ? end : null,
        },
        truncated: end < section.totalCharacters,
        deepLink: ctx.deepLink.project(args.projectId),
      };
    },
  }),
];
