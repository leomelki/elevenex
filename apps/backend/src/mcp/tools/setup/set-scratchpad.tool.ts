import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';

/**
 * set_scratchpad — mutates. Find-or-create a named scratchpad section in a
 * project and optionally set its content. ⚡instant, idempotent on (project,
 * name) so resumed missions reuse the same section instead of duplicating it.
 */
export const setScratchpadTool = defineTool({
  name: 'set_scratchpad',
  title: 'Set scratchpad',
  costClass: 'instant',
  mutates: true,
  description:
    'Find-or-create a named scratchpad section in a project and optionally write its content. ⚡instant, idempotent on (project, name). Use to record durable mission notes.',
  annotations: { idempotentHint: true },
  inputShape: {
    projectId: z
      .number()
      .int()
      .positive()
      .describe('Project the scratchpad section belongs to.'),
    name: z
      .string()
      .min(1)
      .describe('Section name to find or create (matched exactly within the project).'),
    content: z
      .string()
      .optional()
      .describe('Optional content to set on the section (replaces existing content).'),
  },
  handler: async (args, ctx) => {
    const { scratchpad } = ctx.services;
    const name = args.name.trim();

    const existing = (await scratchpad.findByProject(args.projectId)).find(
      (s) => s.name === name,
    );
    const created = existing === undefined;
    const section = existing ?? (await scratchpad.create(args.projectId, name));

    let result = section;
    if (args.content !== undefined) {
      result = await scratchpad.update(section.id, { content: args.content });
    }

    return {
      data: {
        sectionId: result.id,
        name: result.name,
        created,
        contentLength: result.content?.length ?? 0,
      },
      touched: { sectionId: result.id },
      deepLink: ctx.deepLink.project(args.projectId),
    };
  },
});
