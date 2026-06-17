import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

const DEFAULT_EVENTS = ['completed', 'requires_action', 'failed'];
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * await_session_event — block (event-driven, NOT a poll loop) until a session
 * reaches one of the given statuses or the timeout elapses. 🔴 One efficient
 * wait replaces a polling storm: resolves the instant the status changes.
 */
export const awaitSessionEventTool = defineTool({
  name: 'await_session_event',
  title: 'Await session event',
  costClass: 'heavy',
  description:
    "Block until a session reaches one of `events` (default completed/requires_action/failed) or `timeoutMs` elapses — event-driven, not polling. 🔴 Use instead of looping session_status. On resolve: read_session for the delta, or get_pending_action when requires_action.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session id to watch.'),
    events: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Statuses to wake on. Default ['completed','requires_action','failed'].",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
      .describe('Max time to wait in ms (1-300000). Default 60000. Resolves with event:"timeout" on expiry.'),
  },
  handler: async (args, ctx) => {
    const { sessions } = ctx.services;

    // Validate the session exists up front so a bad id fails fast.
    const session = await sessions.findOne(args.sessionId).catch(() => null);
    if (!session) {
      throw new ToolError({
        code: 'session_not_found',
        message: `No session with id ${args.sessionId}.`,
        remediation: 'List valid ids with find_sessions or project_overview.',
      });
    }

    const wanted = new Set(
      args.events && args.events.length > 0 ? args.events : DEFAULT_EVENTS,
    );
    const emitter = sessions as unknown as EventEmitter;

    // Already in a wanted state? Resolve immediately without subscribing.
    if (wanted.has(session.status)) {
      return {
        data: {
          sessionId: session.id,
          event: session.status,
          status: session.status,
        },
        deepLink: ctx.deepLink.session(session.id),
        nextStep:
          session.status === 'requires_action'
            ? 'Blocked: get_pending_action to inspect, then resolve it.'
            : 'read_session for the latest delta.',
      };
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        emitter.off('session-status-changed', onChange);
        ctx.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const finish = (event: string, status: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          data: { sessionId: session.id, event, status },
          deepLink: ctx.deepLink.session(session.id),
          nextStep:
            event === 'timeout'
              ? 'Timed out: re-await, or poll session_status if you suspect no change is coming.'
              : status === 'requires_action'
                ? 'get_pending_action to inspect the block, then resolve it.'
                : 'read_session for the delta.',
        });
      };

      const onChange = (payload: { sessionId: number; status: string }) => {
        if (payload.sessionId !== session.id) return;
        if (wanted.has(payload.status)) finish(payload.status, payload.status);
      };

      const onAbort = () => finish('aborted', session.status);

      emitter.on('session-status-changed', onChange);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('timeout', session.status), args.timeoutMs);

      // Honour an already-aborted signal.
      if (ctx.signal.aborted) onAbort();
    });
  },
});
