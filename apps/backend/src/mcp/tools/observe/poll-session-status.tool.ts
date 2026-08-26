import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool, ToolError, type ToolContext } from '../../tool-registry/tool.types.js';
import { renderMarkdown } from '../../../agent-runtime/conversation-export.service.js';
import {
  isSessionSettled,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

// Cap at ~3 min to stay inside Claude Code's 5-min tool-call timeout.
const POLL_WAIT_MS = 170_000;
// DB statuses that mean the session was killed externally — treat as failed.
const TERMINAL_DB_STATUSES = new Set(['archived', 'stopped']);

/**
 * poll_session_status — blocking continuation poll for a running session.
 *
 * Waits up to 170 s event-driven (no busy loop). On terminal status: returns a
 * small transcript summary so the caller has immediate context. On timeout:
 * returns a short stillRunning signal — call again immediately, no sleep needed.
 *
 * Call this after prompt_session (which returns immediately once the prompt is
 * accepted, without waiting for the turn to finish) whenever you actually need
 * to wait for a session. Each call already consumes up to 170 s of
 * event-driven wall-clock wait, so back-to-back calls are the correct pattern
 * on timeout.
 */
export const pollSessionStatusTool = defineTool({
  name: 'poll_session_status',
  title: 'Poll session status',
  costClass: 'heavy',
  description:
    'Block up to 170 s for a running session to finish (event-driven, not a poll loop). 🔴heavy. Only reports completion once the session is truly settled — a live background task or a prompt queued behind one keeps it waiting even though the visible turn already ended. On completion: returns a small transcript summary (call read_session for the full transcript or more detail). On timeout: returns stillRunning=true — call poll_session_status again immediately, no sleep needed between calls.',
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
    if (session.surface === 'agent') {
      throw new ToolError({
        code: 'agent_session_inaccessible',
        message: `Session ${args.sessionId} is an agent session and cannot be accessed via MCP tools.`,
        remediation: 'Use find_sessions to list accessible sessions.',
      });
    }

    // Already killed at the DB level — no point subscribing.
    if (TERMINAL_DB_STATUSES.has(session.status)) {
      return buildTerminalResult(ctx, session.id, session.activeAgentProvider, 'failed');
    }

    const runtime = ctx.services.agentRuntime.getProvider(session.activeAgentProvider);

    // Check live runtime state before subscribing to close any already-done race.
    // isSessionSettled (not a raw idle/idle check) so a live background task or
    // a prompt queued behind one doesn't get reported as completed early.
    const initialState = await runtime.getRuntimeState(session.id).catch(() => null);
    const initialRuntimeState = initialState as SessionRuntimeSnapshot | null;
    if (initialRuntimeState) {
      if (initialRuntimeState.sessionState === 'requires_action') {
        return buildTerminalResult(ctx, session.id, session.activeAgentProvider, 'requires_action');
      }
      if (initialRuntimeState.runPhase === 'error') {
        return buildTerminalResult(ctx, session.id, session.activeAgentProvider, 'failed');
      }
      if (isSessionSettled(initialRuntimeState)) {
        return buildTerminalResult(ctx, session.id, session.activeAgentProvider, 'completed');
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

      const finish = async (status: string) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (status === 'timeout' || status === 'aborted') {
          resolve({
            data: { sessionId: args.sessionId, stillRunning: true },
            deepLink: ctx.deepLink.session(args.sessionId),
            nextStep:
              'Session still running. Call poll_session_status again immediately — each call already waits 170 s, no sleep needed.',
          });
          return;
        }

        resolve(
          await buildTerminalResult(ctx, args.sessionId, session.activeAgentProvider, status),
        );
      };

      // DB status listener: handles external kills (archived/stopped).
      const onSessionStatus = (payload: { sessionId: number; status: string }) => {
        if (payload.sessionId !== args.sessionId) return;
        if (TERMINAL_DB_STATUSES.has(payload.status)) void finish('failed');
      };

      // Runtime event listener: the actual source of truth for run completion.
      // `run_state` payloads already carry backgroundWork/pendingPrompts, so they
      // can be judged directly. `complete` fires as soon as the visible turn
      // ends even while a background task is still live, and `background_work`
      // fires when that task later clears (possibly with nothing else queued
      // behind it, so no further `complete`/`run_state` event is coming) — both
      // need a fresh read to confirm the session is truly settled.
      const onRuntimeEvent = (event: {
        type: string;
        payload: { sessionId: number } & SessionRuntimeSnapshot;
      }) => {
        if (event.payload.sessionId !== args.sessionId) return;
        if (event.type === 'error') {
          void finish('failed');
        } else if (event.type === 'run_state') {
          if (event.payload.sessionState === 'requires_action') void finish('requires_action');
          else if (event.payload.runPhase === 'error') void finish('failed');
          else if (isSessionSettled(event.payload)) void finish('completed');
        } else if (event.type === 'complete' || event.type === 'background_work') {
          void runtime
            .getRuntimeState(args.sessionId)
            .then((s) => {
              if (isSessionSettled(s as SessionRuntimeSnapshot)) void finish('completed');
            })
            .catch(() => {});
        }
      };

      const onAbort = () => void finish('aborted');

      sessionEmitter.on('session-status-changed', onSessionStatus);
      runtimeEmitter.on('event', onRuntimeEvent);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => void finish('timeout'), POLL_WAIT_MS);

      if (ctx.signal.aborted) {
        onAbort();
        return;
      }

      // Re-check via runtime state after subscribing to close the race between
      // our initial check above and listener registration.
      runtime.getRuntimeState(args.sessionId).then((s) => {
        const state = s as SessionRuntimeSnapshot;
        if (state.sessionState === 'requires_action') void finish('requires_action');
        else if (state.runPhase === 'error') void finish('failed');
        else if (isSessionSettled(state)) void finish('completed');
      }).catch(() => {});
    });
  },
});

async function buildTerminalResult(
  ctx: ToolContext,
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
