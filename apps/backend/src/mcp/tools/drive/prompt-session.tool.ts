import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

const PROMPT_WAIT_MS = 90_000;
const TERMINAL_STATUSES = new Set(['completed', 'requires_action', 'failed']);

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
    const emitter = sessions as unknown as EventEmitter;

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        emitter.off('session-status-changed', onChange);
        ctx.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const finish = (event: string) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (event === 'timeout' || event === 'aborted') {
          resolve({
            data: { sessionId: args.sessionId, accepted: true, stillRunning: true },
            deepLink: ctx.deepLink.session(args.sessionId),
            nextStep:
              'Session is still running after 90 s. Call poll_session_status immediately — it blocks internally so no sleep is needed between calls.',
          });
          return;
        }

        resolve({
          data: { sessionId: args.sessionId, accepted: true, status: event },
          deepLink: ctx.deepLink.session(args.sessionId),
          nextStep:
            event === 'requires_action'
              ? 'Session blocked: get_pending_action to inspect, then resolve_action.'
              : 'Session finished. Call read_session for the transcript.',
        });
      };

      const onChange = (payload: { sessionId: number; status: string }) => {
        if (payload.sessionId !== args.sessionId) return;
        if (TERMINAL_STATUSES.has(payload.status)) finish(payload.status);
      };

      const onAbort = () => finish('aborted');

      emitter.on('session-status-changed', onChange);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('timeout'), PROMPT_WAIT_MS);

      if (ctx.signal.aborted) {
        onAbort();
        return;
      }

      // Re-check status after subscribing to close the race window between
      // submitPrompt completing and our listener being registered.
      sessions.findOne(args.sessionId).then((s) => {
        if (s && TERMINAL_STATUSES.has(s.status)) finish(s.status);
      }).catch(() => {});
    });
  },
});
