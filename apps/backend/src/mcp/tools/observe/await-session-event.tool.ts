import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  isSessionSettled,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

const DEFAULT_EVENTS = ['completed', 'requires_action', 'failed'];
// Cap at ~3 min to stay inside Claude Code's 5-min tool-call timeout.
const DEFAULT_TIMEOUT_MS = 170_000;
const MAX_TIMEOUT_MS = 170_000;
// DB statuses that indicate the session was killed externally.
const TERMINAL_DB_STATUSES = new Set(['archived', 'stopped']);

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
    "Block until a session reaches one of `events` (default completed/requires_action/failed) or `timeoutMs` elapses — event-driven, not polling. 🔴 Use instead of looping session_status. `completed` only fires once the session is truly settled: a live background task or a prompt queued behind one keeps it running even though the visible turn already ended, so this correctly keeps waiting through that instead of returning early. On resolve: read_session for the delta, or get_pending_action when requires_action. On timeout: re-call immediately — no sleep needed.",
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
      .describe('Max time to wait in ms (1-170000). Default 170000. Resolves with event:"timeout" on expiry — re-call immediately, no sleep needed.'),
  },
  handler: async (args, ctx) => {
    const { sessions, agentRuntime } = ctx.services;

    // Validate the session exists up front so a bad id fails fast.
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

    const wanted = new Set(
      args.events && args.events.length > 0 ? args.events : DEFAULT_EVENTS,
    );

    const makeResult = (event: string, status: string) => ({
      data: { sessionId: session.id, event, status },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        event === 'timeout'
          ? 'Still waiting — re-call await_session_event immediately with the same arguments, no sleep needed.'
          : status === 'requires_action'
            ? 'get_pending_action to inspect the block, then resolve it.'
            : 'read_session for the delta.',
    });

    // Map runtime state to a logical event name the caller cares about.
    // idle+idle alone is NOT "completed": a live background task or a prompt
    // queued behind one will resume this session on its own (see
    // session-runtime-state.util.ts) — isSessionSettled accounts for both.
    const runtimeEventFor = (s: SessionRuntimeSnapshot): string | null => {
      if (s.sessionState === 'requires_action') return 'requires_action';
      if (s.runPhase === 'error') return 'failed';
      if (isSessionSettled(s)) return 'completed';
      return null;
    };

    // Already in a terminal DB state (killed externally) — treat as failed.
    if (TERMINAL_DB_STATUSES.has(session.status) && wanted.has('failed')) {
      return makeResult('failed', 'failed');
    }

    const runtime = agentRuntime.getProvider(session.activeAgentProvider);

    // Check live runtime state before subscribing to close any already-done race.
    const initialState = await runtime.getRuntimeState(session.id).catch(() => null);
    if (initialState) {
      const logicalEvent = runtimeEventFor(initialState as SessionRuntimeSnapshot);
      if (logicalEvent && wanted.has(logicalEvent)) {
        return makeResult(logicalEvent, logicalEvent);
      }
    }

    const sessionEmitter = sessions as unknown as EventEmitter;
    const runtimeEmitter = runtime as unknown as EventEmitter;

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        sessionEmitter.off('session-status-changed', onSessionStatus);
        runtimeEmitter.off('event', onRuntimeEvent);
        ctx.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const finish = (event: string, status: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(makeResult(event, status));
      };

      // DB status listener: handles external kills (archived/stopped).
      const onSessionStatus = (payload: { sessionId: number; status: string }) => {
        if (payload.sessionId !== session.id) return;
        if (TERMINAL_DB_STATUSES.has(payload.status) && wanted.has('failed')) {
          finish('failed', 'failed');
        }
      };

      // Runtime event listener: the actual source of truth for run completion.
      // `run_state` payloads already carry backgroundWork/pendingPrompts (see
      // emitRunState), so they can be judged directly. `complete` and
      // `background_work` payloads don't carry the full snapshot — a `complete`
      // can fire while a background task is still live, and a `background_work`
      // clear can fire with nothing queued behind it — so re-check the live
      // state before deciding either one means the session is truly settled.
      const onRuntimeEvent = (event: {
        type: string;
        payload: { sessionId: number } & SessionRuntimeSnapshot;
      }) => {
        if (event.payload.sessionId !== session.id) return;
        if (event.type === 'error') {
          if (wanted.has('failed')) finish('failed', 'failed');
          return;
        }
        if (event.type === 'run_state') {
          const logicalEvent = runtimeEventFor(event.payload);
          if (logicalEvent && wanted.has(logicalEvent)) finish(logicalEvent, logicalEvent);
          return;
        }
        if (event.type !== 'complete' && event.type !== 'background_work') return;
        void runtime
          .getRuntimeState(session.id)
          .then((s) => {
            const logicalEvent = runtimeEventFor(s as SessionRuntimeSnapshot);
            if (logicalEvent && wanted.has(logicalEvent)) finish(logicalEvent, logicalEvent);
          })
          .catch(() => {});
      };

      const onAbort = () => finish('aborted', 'aborted');

      sessionEmitter.on('session-status-changed', onSessionStatus);
      runtimeEmitter.on('event', onRuntimeEvent);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('timeout', 'timeout'), args.timeoutMs);

      // Honour an already-aborted signal.
      if (ctx.signal.aborted) {
        onAbort();
        return;
      }

      // Re-check runtime state after subscribing to close the race between our
      // initial check above and listener registration.
      runtime.getRuntimeState(session.id).then((s) => {
        const logicalEvent = runtimeEventFor(s as SessionRuntimeSnapshot);
        if (logicalEvent && wanted.has(logicalEvent)) finish(logicalEvent, logicalEvent);
      }).catch(() => {});
    });
  },
});
