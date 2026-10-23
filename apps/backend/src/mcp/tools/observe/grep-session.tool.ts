import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { type ConversationExportOptions } from '../../../agent-runtime/conversation-export.service.js';
import { searchSessionTranscript } from './session-grep.js';

/**
 * grep_session — search bounded rendered chunks in a cancellable worker.
 *
 * Renders the session at the requested precision (same pipeline as read_session)
 * and returns matches with surrounding context lines and their line numbers.
 * Use the returned `lineNumber` values directly with read_session_range to zoom
 * into any match — both tools render at the same precision, so coordinates are
 * stable across calls.
 */
export const grepSessionTool = defineTool({
  name: 'grep_session',
  title: 'Search session transcript',
  costClass: 'cached',
  requiresQuery: true,
  description:
    "Search the rendered transcript for a string or regex. ⚠️ The grep runs only against the file generated at the chosen precision — content omitted at that precision level is invisible to this search. 'small' collapses or drops many details; if you might be missing results, retry at a higher precision. Uses JavaScript regex syntax, matched separately on each line, with a 5-second search deadline. Returns matching lines with context and their line numbers; lines are capped at 2000 characters and combined line/context output at 24000 characters, with truncation metadata. Oversized input returns grep_input_limit; at most two searches run concurrently. 🟢 Use read_session_range with the same precision to zoom into any match.",
  annotations: { readOnlyHint: true },
  currentSessionScope: 'session',
  inputShape: {
    sessionId: z.number().int().positive().describe('Session id to search.'),
    query: z
      .string()
      .min(1)
      .max(4096)
      .describe('Search term. Use isRegExp:true for regex patterns.'),
    precision: z
      .enum(['small', 'medium', 'full'])
      .default('small')
      .describe(
        "Detail level of the rendered file that will be searched. ⚠️ Content omitted at this precision is invisible to the grep — a 'small' report collapses or drops many details, so a miss does NOT mean the content is absent. Retry at 'medium' or 'full' if completeness matters. Must match the precision used in read_session_range when combining results.",
      ),
    isRegExp: z
      .boolean()
      .default(false)
      .describe('Treat query as a regular expression.'),
    caseSensitive: z
      .boolean()
      .default(false)
      .describe('Case-sensitive matching (default: case-insensitive).'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(3)
      .describe(
        'Lines of context to include before and after each match (0–10). Default 3.',
      ),
    maxMatches: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Max matches to return (1–50). Default 20.'),
  },
  handler: async (args, ctx) => {
    ctx.signal.throwIfAborted();
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

    const { model } = await conversationExport.buildModel(
      session.id,
      session.activeAgentProvider,
    );

    const options: ConversationExportOptions = {
      precision: args.precision,
      includeChanges: false,
      includeIds: false,
    };
    const result = await searchSessionTranscript(
      model,
      options,
      args,
      ctx.signal,
    );
    const { matches, truncated } = result;

    return {
      data: {
        sessionId: session.id,
        precision: args.precision,
        ...result,
      },
      truncated,
      deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
      nextStep:
        matches.length === 0
          ? `No matches found at precision:'${args.precision}'. This grep only searches the content rendered at that level — details omitted by the precision setting are invisible. Try a higher precision (${args.precision === 'small' ? "'medium' or 'full'" : "'full'"}) before concluding the content is absent, or broaden your query / set isRegExp:true.`
          : truncated
            ? `Search output was capped (${Object.entries(result.truncation)
                .filter(([, capped]) => capped)
                .map(([reason]) => reason)
                .join(
                  ', ',
                )}). Narrow your query or use read_session_range at the returned line numbers.`
            : `Use read_session_range with precision:'${args.precision}' and a lineNumber ± window to zoom into any match. Remember: this search only covers content rendered at '${args.precision}' precision — switch to a higher precision if you need finer detail.`,
    };
  },
});
