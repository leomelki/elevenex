import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * ask_session — ask a quick question ABOUT a running session's work and get back
 * JUST the answer. 🔴heavy: it spins up a hidden Q&A fork of the session,
 * submits the question, and waits (bounded) for the answer — it does NOT touch
 * the real transcript. Use this instead of read_session when you want a synthesised
 * answer ("did it finish X?", "why did it pick Y?") rather than the raw delta;
 * use read_session to inspect the actual messages.
 */
export const askSessionTool = defineTool({
  name: 'ask_session',
  title: 'Ask session',
  costClass: 'heavy',
  mutates: true,
  description:
    "Ask a quick question ABOUT a session's work and get back JUST the answer, via a hidden Q&A fork that never pollutes the real transcript. 🔴heavy: bounded wait, then returns the answer or a {running, forkId} handle. Use instead of read_session when you want a synthesised answer rather than raw messages; read_session to inspect the transcript itself.",
  annotations: { openWorldHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to ask about. Get ids from find_sessions / project_overview.'),
    question: z
      .string()
      .min(1)
      .describe(
        'The question about this session\'s work. The fork answers ONLY this; it does not continue the task or modify files.',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
      .describe(
        `Max ms to wait for the answer before returning a {running, forkId} handle. Default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}.`,
      ),
  },
  handler: async (args, ctx) => {
    const { sessions, planChatForks } = ctx.services;

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

    let result: Awaited<ReturnType<typeof planChatForks.ask>>;
    try {
      result = await planChatForks.ask(args.sessionId, {
        question: args.question,
        surface: 'agent_query',
        timeoutMs: args.timeoutMs,
        signal: ctx.signal,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : `Could not ask session ${args.sessionId}.`;
      throw new ToolError({
        code: 'ask_session_failed',
        message,
        remediation:
          'The session may be busy producing a response or have no conversation yet. Gate with session_status (wait until idle) and retry.',
        retryable: true,
      });
    }

    if (result.answer !== null) {
      return {
        data: { answer: result.answer },
        touched: { forkId: result.forkId },
        nextStep: 'Ask again or prompt_session to act on the answer.',
      };
    }

    return {
      data: {
        running: true,
        forkId: result.forkId,
        hint: 'Answer not ready; read_session on forkId or call ask_session again later.',
      },
      touched: { forkId: result.forkId },
      nextStep:
        'Answer not ready: read_session on forkId, or call ask_session again later.',
    };
  },
});
