import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';
import {
  isSessionSettled,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

/**
 * prompt_session — trigger or continue a session's agent with a prompt. Ensures
 * the session is started, submits the prompt, and returns as soon as the
 * runtime has accepted it (or queued it) — it never blocks waiting for the
 * turn to finish. This is what lets the caller fan a prompt out to many
 * sessions back-to-back instead of being stuck on the first one; use
 * poll_session_status / await_session_event afterward to wait for completion.
 */
export const promptSessionTool = defineTool({
  name: 'prompt_session',
  title: 'Prompt session',
  costClass: 'heavy',
  mutates: true,
  description:
    "Send a prompt to a session's agent. 🔴heavy. Starts the session if needed, submits the prompt, and returns immediately once it is accepted — it does NOT wait for the turn to finish, so you can prompt_session other sessions right away instead of waiting on this one. Call poll_session_status or await_session_event when you actually need to wait for this session. Resolve any permission prompts with get_pending_action → resolve_action.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to prompt. Get ids from find_sessions / project_overview.'),
    prompt: z
      .string()
      .min(1)
      .describe(
        'The instruction to send to the agent. Required, non-empty. Keep each prompt scoped to one coherent concern (one feature/fix/investigation) rather than bundling unrelated work — split unrelated concerns across separate prompts or sessions to avoid long, tangled sessions.',
      ),
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
    // submitPrompt() resolves once the runtime has actually accepted the
    // prompt — started a fresh run, or queued it behind live background work —
    // not once the turn completes. That is exactly the "received and started"
    // signal we want; nothing below this line should block further.
    await runtime.submitPrompt(args.sessionId, args.prompt);

    const state = await runtime.getRuntimeState(args.sessionId).catch(() => null);
    const runtimeState = state as SessionRuntimeSnapshot | null;

    let status = 'running';
    if (runtimeState) {
      if (runtimeState.sessionState === 'requires_action') status = 'requires_action';
      else if (runtimeState.runPhase === 'error') status = 'failed';
      else if (isSessionSettled(runtimeState)) status = 'completed';
    }

    const nextStep =
      status === 'requires_action'
        ? 'Session blocked: get_pending_action to inspect, then resolve_action.'
        : status === 'failed'
          ? 'Session finished. Call read_session for the transcript.'
          : status === 'completed'
            ? 'Session finished already (fast turn). Call read_session for the transcript.'
            : 'Prompt accepted; the session is working in the background. Call poll_session_status or await_session_event to wait for it — or prompt_session other sessions now rather than waiting on this one.';

    return {
      data: { sessionId: args.sessionId, accepted: true, provider, status },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep,
    };
  },
});
