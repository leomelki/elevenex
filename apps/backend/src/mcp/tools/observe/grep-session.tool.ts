import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  renderMarkdown,
  type ConversationExportOptions,
} from '../../../agent-runtime/conversation-export.service.js';

/**
 * grep_session — search the full rendered transcript without loading it whole.
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
    "Search the full rendered transcript for a string or regex without loading it whole. Returns matching lines with context and their line numbers. 🟢 Use read_session_range with the returned lineNumbers to zoom in. Precision must match when combining with read_session_range.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id to search.'),
    query: z
      .string()
      .min(1)
      .describe('Search term. Use isRegExp:true for regex patterns.'),
    precision: z
      .enum(['small', 'medium', 'full'])
      .default('small')
      .describe(
        "Transcript detail level to search. Must match the precision used in read_session_range when combining results.",
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
      .describe('Lines of context to include before and after each match (0–10). Default 3.'),
    maxMatches: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Max matches to return (1–50). Default 20.'),
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

    let pattern: RegExp;
    try {
      pattern = args.isRegExp
        ? new RegExp(args.query, args.caseSensitive ? 'g' : 'gi')
        : new RegExp(escapeRegExp(args.query), args.caseSensitive ? 'g' : 'gi');
    } catch {
      throw new ToolError({
        code: 'invalid_regexp',
        message: `Invalid regular expression: ${args.query}`,
        remediation: 'Fix the pattern syntax or set isRegExp:false for a literal search.',
      });
    }

    const matches: {
      lineNumber: number;
      line: string;
      context: string;
    }[] = [];

    // Track already-covered line ranges so context windows don't create duplicates
    // when matches are close together.
    let lastContextEnd = -1;

    for (let i = 0; i < lines.length && matches.length < args.maxMatches; i++) {
      pattern.lastIndex = 0;
      if (!pattern.test(lines[i])) continue;

      const contextStart = Math.max(0, i - args.contextLines);
      const contextEnd = Math.min(totalLines - 1, i + args.contextLines);

      const contextLines = lines
        .slice(contextStart, contextEnd + 1)
        .map((l, offset) => {
          const lineNum = contextStart + offset + 1;
          return lineNum === i + 1 ? `>>> ${l}` : `    ${l}`;
        })
        .join('\n');

      matches.push({
        lineNumber: i + 1, // 1-based
        line: lines[i],
        context: contextLines,
      });

      lastContextEnd = contextEnd;
    }

    const truncated = matches.length >= args.maxMatches;

    return {
      data: {
        sessionId: session.id,
        precision: args.precision,
        totalLines,
        matchCount: matches.length,
        truncated,
        matches,
      },
      truncated,
      deepLink: ctx.deepLink.session(session.id, { panel: 'transcript' }),
      nextStep:
        matches.length === 0
          ? 'No matches found. Try a broader query, different precision, or isRegExp:true.'
          : truncated
            ? `Capped at ${args.maxMatches} matches. Narrow your query or increase maxMatches.`
            : `Use read_session_range with precision:'${args.precision}' and a lineNumber ± window to zoom into any match.`,
    };
  },
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
