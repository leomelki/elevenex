import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  renderMarkdown,
  type ConversationExportModel,
  type ConversationExportOptions,
} from '../../../agent-runtime/conversation-export.service.js';

/**
 * read_session — transcript reader backed by the structured Markdown export.
 *
 * First call for a (session, precision) pair returns the full session.
 * Subsequent calls return only turns added since the last read (delta), with
 * turn numbers that reflect their global position in the session. Changing
 * precision resets the cursor and delivers a fresh full read at the new level.
 */
export const readSessionTool = defineTool({
  name: 'read_session',
  title: 'Read session transcript',
  costClass: 'cached',
  description:
    "Read a session's transcript as structured Markdown. First call returns the full session; repeat calls return only new turns (delta). 🟢 Gate with session_status first. Precision: 'small' = user+final-response (cheapest), 'medium' adds work steps, 'full' adds thinking and tool outputs with diffs.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id whose transcript to read.'),
    precision: z
      .enum(['small', 'medium', 'full'])
      .default('small')
      .describe(
        "'small' returns user messages + final responses only (cheapest). 'medium' adds intermediate work steps. 'full' adds thinking blocks and tool inputs/outputs with diffs. Changing precision resets the delta cursor.",
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

    const { model, running } = await conversationExport.buildModel(
      session.id,
      session.activeAgentProvider,
    );

    const totalTurns = model.turns.length;
    // Cursor scope encodes precision so a change in detail level resets to a
    // full read rather than delivering a misleadingly-scoped delta.
    const cursorScope = `${session.id}:${args.precision}`;
    const stored = ctx.cursors.get(ctx.mcpSessionId, cursorScope);
    const fromTurn = stored !== undefined ? parseInt(stored, 10) : 0;
    const isDelta = stored !== undefined;
    const newTurns = totalTurns - fromTurn;

    if (isDelta && newTurns === 0) {
      // Nothing new — skip rendering entirely.
      return {
        data: { sessionId: session.id, delta: true, newTurns: 0, totalTurns, running },
        deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
        nextStep: running
          ? 'No new turns yet; runtime is still running. Use await_session_event or poll session_status.'
          : 'No new turns. Session is idle.',
      };
    }

    const options: ConversationExportOptions = {
      precision: args.precision,
      includeChanges: args.includeChanges,
      includeIds: args.includeIds,
      turnNumberOffset: isDelta ? fromTurn : 0,
    };

    const slicedModel: ConversationExportModel = {
      ...model,
      // Preamble (system init items) only belongs in the first full read.
      preamble: isDelta ? [] : model.preamble,
      turns: model.turns.slice(fromTurn),
    };

    const markdown = renderMarkdown(slicedModel, options);

    ctx.cursors.set(ctx.mcpSessionId, cursorScope, String(totalTurns));

    return {
      data: {
        sessionId: session.id,
        delta: isDelta,
        newTurns,
        totalTurns,
        running,
        markdown,
      },
      deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
      nextStep: running
        ? 'Runtime still running; use await_session_event then re-read for the next delta.'
        : isDelta
          ? `Delta delivered (turns ${fromTurn + 1}–${totalTurns}). Re-read when you expect more turns.`
          : `Full session delivered (${totalTurns} turn${totalTurns === 1 ? '' : 's'}). Re-read for future deltas.`,
    };
  },
});
