import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  renderMarkdown,
  type ConversationExportOptions,
} from '../../../agent-runtime/conversation-export.service.js';

/**
 * read_session_range — zoom into a specific line window of the rendered
 * transcript without fetching the whole document.
 *
 * Use grep_session first to find the lineNumber(s) of interest, then call
 * this with a [startLine, endLine] window around those numbers. Both tools
 * render at the same precision so line coordinates are stable.
 */
export const readSessionRangeTool = defineTool({
  name: 'read_session_range',
  title: 'Read session transcript range',
  costClass: 'cached',
  description:
    "Read a specific line window of the rendered transcript. Use grep_session first to find lineNumbers, then zoom in here. Precision must match the grep call to keep line numbers stable. Returns the raw Markdown slice + totalLines for context.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id to read.'),
    startLine: z
      .number()
      .int()
      .min(1)
      .describe('First line to return (1-based, inclusive). Use a lineNumber from grep_session minus a padding window.'),
    endLine: z
      .number()
      .int()
      .min(1)
      .describe('Last line to return (1-based, inclusive).'),
    precision: z
      .enum(['small', 'medium', 'full'])
      .default('small')
      .describe(
        "Must match the precision used in grep_session to keep line numbers consistent.",
      ),
  },
  handler: async (args, ctx) => {
    const { sessions, conversationExport } = ctx.services;

    if (args.endLine < args.startLine) {
      throw new ToolError({
        code: 'invalid_range',
        message: `endLine (${args.endLine}) must be ≥ startLine (${args.startLine}).`,
        remediation: 'Swap startLine and endLine, or widen the range.',
      });
    }

    const MAX_LINES = 200;
    if (args.endLine - args.startLine + 1 > MAX_LINES) {
      throw new ToolError({
        code: 'range_too_large',
        message: `Requested ${args.endLine - args.startLine + 1} lines; max is ${MAX_LINES}.`,
        remediation: `Narrow to a ${MAX_LINES}-line window. Use grep_session to find the exact area first.`,
      });
    }

    const session = await sessions.findOne(args.sessionId).catch(() => null);
    if (!session) {
      throw new ToolError({
        code: 'session_not_found',
        message: `No session with id ${args.sessionId}.`,
        remediation: 'List valid ids with find_sessions or project_overview.',
      });
    }

    const { model } = await conversationExport.buildModel(
      session.id,
      session.activeAgentProvider,
    );

    const options: ConversationExportOptions = {
      precision: args.precision,
      includeChanges: false,
      includeIds: false,
    };
    const markdown = renderMarkdown(model, options);
    const lines = markdown.split('\n');
    const totalLines = lines.length;

    // Clamp to actual document bounds.
    const actualStart = Math.min(args.startLine, totalLines);
    const actualEnd = Math.min(args.endLine, totalLines);

    const slice = lines
      .slice(actualStart - 1, actualEnd) // convert to 0-based
      .join('\n');

    return {
      data: {
        sessionId: session.id,
        precision: args.precision,
        startLine: actualStart,
        endLine: actualEnd,
        totalLines,
        content: slice,
      },
      deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
      nextStep:
        actualEnd < totalLines
          ? `Lines ${actualStart}–${actualEnd} of ${totalLines}. Call again with startLine:${actualEnd + 1} to continue reading.`
          : `Lines ${actualStart}–${actualEnd} of ${totalLines} (end of document).`,
    };
  },
});
