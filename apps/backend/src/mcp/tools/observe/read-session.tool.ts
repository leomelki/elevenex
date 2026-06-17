import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * read_session — the transcript DELTA reader and the heart of the token
 * economy. 🟢 By default returns only items new since this connection last
 * read (per-connection cursor), compacted to id/role/short-text. Pass `ids` to
 * zoom into specific messages, or `sinceMessageId` to override the cursor.
 */
export const readSessionTool = defineTool({
  name: 'read_session',
  title: 'Read session transcript',
  costClass: 'cached',
  paginated: true,
  description:
    "Read a session's transcript as a compact DELTA — only what's new since you last read it (per-connection cursor), or specific ids/zoom. 🟢 Gate with session_status first. Returns id/role/short-text, not raw blocks. Next: pass an id in `ids` to zoom, or await_session_event when running.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id whose transcript to read.'),
    sinceMessageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Return items after this message id. Omit to use the per-connection cursor (advances automatically); pass to override.',
      ),
    ids: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Fetch ONLY these specific message ids (a targeted zoom). Overrides sinceMessageId/cursor when set.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe('Max items to return (1-100). Default 30; most-recent kept when capped.'),
    format: z
      .enum(['compact', 'full'])
      .default('compact')
      .describe(
        "Reserved shape hint. 'compact' (default) returns id/role/short-text; 'full' is the same compact shape today.",
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

    const usingIds = !!args.ids && args.ids.length > 0;
    // Default cursor lookup only applies to forward deltas, not id zooms.
    const cursor = usingIds
      ? undefined
      : args.sinceMessageId ?? ctx.cursors.get(ctx.mcpSessionId, session.id);

    const result = await conversationExport.readDelta(
      session.id,
      session.activeAgentProvider,
      { sinceMessageId: cursor, ids: args.ids, limit: args.limit },
    );

    // Advance the connection cursor to the newest item we know about, so the
    // next default read returns only what arrives after this point. We never
    // advance on an explicit `ids` zoom (it isn't a forward read).
    if (!usingIds && result.lastMessageId) {
      ctx.cursors.set(ctx.mcpSessionId, session.id, result.lastMessageId);
    }

    if (result.items.length === 0) {
      return {
        data: { sessionId: session.id, newItems: 0, running: result.running },
        deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
        nextStep: result.running
          ? 'No new items yet; runtime is still running. await_session_event or poll session_status.'
          : 'No new items; await_session_event or poll session_status.',
      };
    }

    return {
      data: {
        sessionId: session.id,
        newItems: result.items.length,
        total: result.total,
        running: result.running,
        items: result.items,
      },
      truncated: result.truncated,
      deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
      nextStep: result.truncated
        ? 'Capped: re-call read_session to page the rest, or narrow with `ids`.'
        : result.running
          ? 'Runtime still running; await_session_event for the next change.'
          : 'Zoom a message by passing its id in `ids`, or drive the session.',
    };
  },
});
