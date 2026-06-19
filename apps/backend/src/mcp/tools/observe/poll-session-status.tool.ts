import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { renderMarkdown } from '../../../agent-runtime/conversation-export.service.js';

const POLL_WAIT_MS = 90_000;
const TERMINAL_STATUSES = new Set(['completed', 'requires_action', 'failed']);

/**
 * poll_session_status — blocking continuation poll for a running session.
 *
 * Waits up to 90 s event-driven (no busy loop). On terminal status: returns a
 * small transcript summary so the caller has immediate context. On timeout:
 * returns a short stillRunning signal — call again immediately, no sleep needed.
 *
 * Designed to be called in a tight loop after prompt_session returns
 * stillRunning=true. Each call already consumes 90 s of wall-clock wait, so
 * back-to-back calls are the correct pattern.
 */
export const pollSessionStatusTool = defineTool({
  name: 'poll_session_status',
  title: 'Poll session status',
  costClass: 'heavy',
  description:
    'Block up to 90 s for a running session to finish (event-driven, not a poll loop). 🔴heavy. On completion: returns a small transcript summary (call read_session for the full transcript or more detail). On timeout: returns stillRunning=true — call poll_session_status again immediately, no sleep needed between calls.',
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id to wait on. Returned by prompt_session or find_sessions.'),
  },
  handler: async (args, ctx) => {
    const { sessions } = ctx.services;

    const session = await sessions.findOne(args.sessionId).catch(() => null);
    if (!session) {
      throw new ToolError({
        code: 'session_not_found',
        message: `No session with id ${args.sessionId}.`,
        remediation: 'List valid ids with find_sessions or project_overview.',
      });
    }

    // Already terminal — return the transcript immediately without subscribing.
    if (TERMINAL_STATUSES.has(session.status)) {
      return buildTerminalResult(ctx, session.id, session.activeAgentProvider, session.status);
    }

    const emitter = sessions as unknown as EventEmitter;

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        emitter.off('session-status-changed', onChange);
        ctx.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const finish = async (event: string, currentStatus: string) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (event === 'timeout' || event === 'aborted') {
          resolve({
            data: { sessionId: args.sessionId, stillRunning: true },
            deepLink: ctx.deepLink.session(args.sessionId),
            nextStep:
              'Session still running. Call poll_session_status again immediately — each call already waits 90 s, no sleep needed.',
          });
          return;
        }

        resolve(
          await buildTerminalResult(ctx, args.sessionId, session.activeAgentProvider, currentStatus),
        );
      };

      const onChange = (payload: { sessionId: number; status: string }) => {
        if (payload.sessionId !== args.sessionId) return;
        if (TERMINAL_STATUSES.has(payload.status)) void finish(payload.status, payload.status);
      };

      const onAbort = () => void finish('aborted', session.status);

      emitter.on('session-status-changed', onChange);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => void finish('timeout', session.status), POLL_WAIT_MS);

      if (ctx.signal.aborted) {
        onAbort();
        return;
      }

      // Re-check after subscribing to close the race between our check above and
      // listener registration.
      sessions.findOne(args.sessionId).then((s) => {
        if (s && TERMINAL_STATUSES.has(s.status)) void finish(s.status, s.status);
      }).catch(() => {});
    });
  },
});

async function buildTerminalResult(
  ctx: Parameters<typeof pollSessionStatusTool['handler']>[1],
  sessionId: number,
  provider: string,
  status: string,
) {
  let markdown: string | undefined;
  try {
    const { model } = await ctx.services.conversationExport.buildModel(sessionId, provider);
    // Return the last 5 turns at small precision — enough to understand what
    // happened without flooding the context. The agent can call read_session for
    // the full transcript or a delta at any precision level.
    const tail = model.turns.slice(-5);
    markdown = renderMarkdown(
      { ...model, preamble: [], turns: tail },
      {
        precision: 'small',
        includeChanges: false,
        includeIds: false,
        turnNumberOffset: Math.max(0, model.turns.length - 5),
      },
    );
  } catch {
    // Transcript unavailable — still return the status so the agent can act.
  }

  return {
    data: {
      sessionId,
      status,
      transcriptSummary: markdown,
      transcriptNote: markdown
        ? 'Showing last 5 turns at small precision. Call read_session for the full transcript or a specific precision level.'
        : 'Transcript unavailable. Call read_session to fetch it.',
    },
    deepLink: ctx.deepLink.session(sessionId),
    nextStep:
      status === 'requires_action'
        ? 'Session blocked: get_pending_action to inspect the permission prompt, then resolve_action.'
        : 'Session finished. Call read_session for the full transcript or more detail.',
  };
}
