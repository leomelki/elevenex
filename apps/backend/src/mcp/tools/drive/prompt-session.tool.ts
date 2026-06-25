import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

const PROMPT_WAIT_MS = 90_000;
// DB statuses that mean the session was killed externally — treat as failed.
const TERMINAL_DB_STATUSES = new Set(['archived', 'stopped']);

/**
 * prompt_session — trigger or continue a session's agent with a prompt. Ensures
 * the session is started, submits the prompt, then waits up to 90 s for it to
 * finish. If it finishes within that window, returns the terminal status. If it
 * is still running after 90 s, returns stillRunning=true — the caller should
 * immediately invoke poll_session_status (no sleep needed; each call blocks
 * internally for up to 90 s).
 */
export const promptSessionTool = defineTool({
  name: 'prompt_session',
  title: 'Prompt session',
  costClass: 'heavy',
  mutates: true,
  description:
    "Send a prompt to a session's agent and wait up to 90 s for it to finish. 🔴heavy. If the session completes, returns status='completed'. If still running after 90 s, returns stillRunning=true — call poll_session_status immediately (no delay needed; it blocks internally). Resolve any permission prompts with get_pending_action → resolve_action.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to prompt. Get ids from find_sessions / project_overview.'),
    prompt: z
      .string()
      .min(1)
      .describe('The instruction to send to the agent. Required, non-empty.'),
  },
  handler: async (args, ctx) => {
    const { sessions } = ctx.services;
    const { session, provider } = await resolveSessionProvider(ctx, args.sessionId);

    // Idempotent start: archived sessions throw inside start(); active ones are
    // a cheap no-op. We start unless already in a live run state.
    if (session.status !== 'active' && session.status !== 'running') {
      await sessions.start(args.sessionId);
    }

    const runtime = ctx.services.agentRuntime.getProvider(provider);
    await runtime.submitPrompt(args.sessionId, args.prompt);

    // Block up to 90 s for the session to reach a terminal status. This removes
    // the need for a separate await_session_event call in the fast-path where the
    // session completes quickly.
    const sessionEmitter = sessions as unknown as EventEmitter;
    const runtimeEmitter = runtime as unknown as EventEmitter;

    // Pre-check: submitPrompt() sets runPhase='running' before returning, so
    // seeing idle here means the prompt already finished (very fast turn or a
    // stale/non-running session that never transitioned). Resolve immediately
    // rather than waiting up to 90 s for an event that already fired.
    const initialState = await runtime.getRuntimeState(args.sessionId).catch(() => null);
    const initialRuntimeState = initialState as { sessionState?: string | null; runPhase?: string | null } | null;
    if (initialRuntimeState) {
      if (initialRuntimeState.sessionState === 'requires_action') {
        return {
          data: { sessionId: args.sessionId, accepted: true, status: 'requires_action' },
          deepLink: ctx.deepLink.session(args.sessionId),
          nextStep: 'Session blocked: get_pending_action to inspect, then resolve_action.',
        };
      }
      if (initialRuntimeState.runPhase === 'error') {
        return {
          data: { sessionId: args.sessionId, accepted: true, status: 'failed' },
          deepLink: ctx.deepLink.session(args.sessionId),
          nextStep: 'Session finished. Call read_session for the transcript.',
        };
      }
      if (initialRuntimeState.sessionState === 'idle' && initialRuntimeState.runPhase === 'idle') {
        return {
          data: { sessionId: args.sessionId, accepted: true, status: 'completed' },
          deepLink: ctx.deepLink.session(args.sessionId),
          nextStep: 'Session finished. Call read_session for the transcript.',
        };
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        sessionEmitter.off('session-status-changed', onSessionStatus);
        runtimeEmitter.off('event', onRuntimeEvent);
        ctx.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const finish = (status: string) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (status === 'timeout' || status === 'aborted') {
          resolve({
            data: { sessionId: args.sessionId, accepted: true, stillRunning: true },
            deepLink: ctx.deepLink.session(args.sessionId),
            nextStep:
              'Session is still running after 90 s. Call poll_session_status immediately — it blocks internally so no sleep is needed between calls.',
          });
          return;
        }

        resolve({
          data: { sessionId: args.sessionId, accepted: true, status },
          deepLink: ctx.deepLink.session(args.sessionId),
          nextStep:
            status === 'requires_action'
              ? 'Session blocked: get_pending_action to inspect, then resolve_action.'
              : 'Session finished. Call read_session for the transcript.',
        });
      };

      // DB status listener: handles external kills (archived/stopped).
      const onSessionStatus = (payload: { sessionId: number; status: string }) => {
        if (payload.sessionId !== args.sessionId) return;
        if (TERMINAL_DB_STATUSES.has(payload.status)) finish('failed');
      };

      // Runtime event listener: the actual source of truth for run completion.
      const onRuntimeEvent = (event: {
        type: string;
        payload: { sessionId: number; sessionState?: string | null; runPhase?: string | null };
      }) => {
        if (event.payload.sessionId !== args.sessionId) return;
        if (event.type === 'complete') {
          finish('completed');
        } else if (event.type === 'run_state') {
          if (event.payload.sessionState === 'requires_action') finish('requires_action');
          else if (event.payload.runPhase === 'error') finish('failed');
          else if (event.payload.sessionState === 'idle' && event.payload.runPhase === 'idle') finish('completed');
        } else if (event.type === 'error') {
          finish('failed');
        }
      };

      const onAbort = () => finish('aborted');

      sessionEmitter.on('session-status-changed', onSessionStatus);
      runtimeEmitter.on('event', onRuntimeEvent);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('timeout'), PROMPT_WAIT_MS);

      if (ctx.signal.aborted) {
        onAbort();
        return;
      }

      // Re-check after subscribing to close the race between the pre-check above
      // and listener registration. Handles the case where the prompt completed
      // during that window.
      runtime.getRuntimeState(args.sessionId).then((s) => {
        const state = s as { sessionState?: string | null; runPhase?: string | null };
        if (state.sessionState === 'requires_action') finish('requires_action');
        else if (state.runPhase === 'error') finish('failed');
        else if (state.sessionState === 'idle' && state.runPhase === 'idle') finish('completed');
      }).catch(() => {});
    });
  },
});
