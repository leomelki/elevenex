import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { transcriptWindow } from './transcript-window.js';

/** Bounded transcript pages with connection-local delta cursors. */
export const readSessionTool = defineTool({
  name: 'read_session',
  title: 'Read session transcript',
  costClass: 'cached',
  description:
    "Read bounded Markdown transcript pages (default 20 turns/12000 characters). Repeat to drain truncated pages, then receive deltas. refresh:true rereads history. Rewinds/provider changes reset automatically. 'small' shows user/final responses; 'medium' adds work; 'full' adds tool details. includeIds:true discovers fork anchors.",
  annotations: { readOnlyHint: true },
  currentSessionScope: 'session',
  inputShape: {
    cursor: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Opaque cursor returned by the previous response. Optional for stateful MCP connections; required to continue pages for stateless clients.',
      ),
    refresh: z
      .boolean()
      .optional()
      .describe(
        'Restart at the beginning; default false. Set only for the first call of a fresh read.',
      ),
    maxTurns: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Turns per page, 1-50; default 20.'),
    maxCharacters: z
      .number()
      .int()
      .min(1000)
      .max(24000)
      .optional()
      .describe(
        'Maximum Markdown characters per response, 1000-24000; default 12000. A large turn continues on the next call.',
      ),
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id whose transcript to read.'),
    precision: z
      .enum(['small', 'medium', 'full'])
      .default('small')
      .describe(
        "'small' returns user messages + final responses only (cheapest). 'medium' adds intermediate work steps. 'full' adds thinking blocks and tool inputs/outputs with diffs. Changing rendering options starts a separate delta cursor.",
      ),
    includeChanges: z
      .boolean()
      .default(false)
      .describe(
        'Include per-turn file change stats (+/- lines, filenames). Useful when reviewing what the session modified.',
      ),
    includeIds: z
      .boolean()
      .default(false)
      .describe(
        'Annotate each item with its message id. Enable when you need to reference or zoom into specific messages.',
      ),
  },
  handler: async (args, ctx) => {
    const { sessions, conversationExport } = ctx.services;

    const session = await sessions.findOne(args.sessionId).catch(() => null);
    if (!session) {
      throw new ToolError({
        code: 'session_not_found',
        message: `No session with id ${args.sessionId}.`,
        remediation: 'List valid ids with find_sessions or project_overview.',
      });
    }
    if (session.surface === 'agent') {
      throw new ToolError({
        code: 'agent_session_inaccessible',
        message: `Session ${args.sessionId} is an agent session and cannot be accessed via MCP tools.`,
        remediation: 'Use find_sessions to list accessible sessions.',
      });
    }

    const { model, running, itemCount } = await conversationExport.buildModel(
      session.id,
      session.activeAgentProvider,
    );

    const identity = [
      session.activeAgentProvider,
      session.claudeSessionId,
      session.codexSessionId,
      session.piSessionPath,
      session.opencodeSessionId,
      model.turns[0]?.user?.id,
      args.precision,
      args.includeChanges,
      args.includeIds,
    ].join(':');
    const cursorScope = `${session.id}:${args.precision}:${args.includeChanges}:${args.includeIds}`;
    const page = transcriptWindow(
      model,
      itemCount ?? 0,
      identity,
      args.cursor ?? ctx.cursors.get(ctx.mcpSessionId, cursorScope),
      args,
    );
    ctx.signal.throwIfAborted();
    ctx.cursors.set(ctx.mcpSessionId, cursorScope, page.cursor);
    return {
      data: {
        sessionId: session.id,
        running,
        ...page.data,
        cursor: page.cursor,
      },
      truncated: page.truncated,
      deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
      nextStep: page.truncated
        ? 'More transcript remains. Repeat read_session with the same rendering options and refresh omitted/false to continue.'
        : running
          ? 'Runtime still running; await_session_event before reading the next delta.'
          : 'Transcript caught up. Repeat for future deltas, or refresh:true to reread history.',
    };
  },
});
