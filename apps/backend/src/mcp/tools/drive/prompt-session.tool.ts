import { z } from 'zod';
import { serializeSessionMention } from '../../../agent-runtime/session-mention.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
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
    "Send a prompt to a session's agent, optionally mentioning previous sessions with compact snapshots and transcript paths (like chat mentions). 🔴heavy. Starts the session if needed, submits the prompt, and returns immediately once it is accepted — it does NOT wait for the turn to finish, so you can prompt_session other sessions right away instead of waiting on this one. Call poll_session_status or await_session_event when you actually need to wait for this session. Resolve any permission prompts with get_pending_action → resolve_action.",
  disallowSelfTarget: 'session',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe(
        'Session to prompt. Get ids from find_sessions / project_overview.',
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        'The instruction to send to the agent. Required, non-empty. Keep each prompt scoped to one coherent concern (one feature/fix/investigation) rather than bundling unrelated work — split unrelated concerns across separate prompts or sessions to avoid long, tangled sessions.',
      ),
    mentionSessionIds: z
      .array(z.number().int().positive())
      .max(10)
      .optional()
      .describe(
        'Optional previous session IDs to attach as chat-style context mentions (max 10; duplicates ignored). May include your current coding session, archived sessions, or sessions from other tasks; cannot include the target or orchestration missions. For a fresh session needing prior outcomes rather than detailed working context, mention only relevant sessions and state the next goal in prompt. Snapshots omit intermediate steps but can still be long; continue the existing session for tightly coupled work.',
      ),
  },
  handler: async (args, ctx) => {
    const { sessions } = ctx.services;
    await sessions.assertSessionWorkspaceLinked(args.sessionId);
    let { session, provider } = await resolveSessionProvider(
      ctx,
      args.sessionId,
    );

    const mentionSessionIds = [...new Set(args.mentionSessionIds ?? [])];
    // Validate all references before exporting history or starting the target.
    for (const sessionId of mentionSessionIds) {
      ctx.signal.throwIfAborted();
      if (sessionId === args.sessionId) {
        throw new ToolError({
          code: 'invalid_session_mention',
          message: 'A session cannot mention itself in its own prompt.',
          remediation:
            'Mention previous sessions, or omit mentionSessionIds to continue this session.',
        });
      }
      await resolveSessionProvider(ctx, sessionId);
    }
    const mentions: string[] = [];
    for (const sessionId of mentionSessionIds) {
      ctx.signal.throwIfAborted();
      try {
        const mention =
          await ctx.services.conversationExport.buildMention(sessionId);
        ctx.signal.throwIfAborted();
        mentions.push(serializeSessionMention(mention));
      } catch (error) {
        ctx.signal.throwIfAborted();
        throw new ToolError({
          code: 'session_mention_failed',
          message: `Could not build context for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          remediation:
            'Read the source with read_session or ask_session and pass its relevant findings in prompt, or retry the mention when its history is available.',
          retryable: true,
        });
      }
    }
    const prompt = mentions.length
      ? [args.prompt, ...mentions].join('\n\n')
      : args.prompt;
    ctx.signal.throwIfAborted();

    if (mentionSessionIds.length) {
      // Reading source histories can be slow. The target may have been
      // archived, reconfigured, or moved to an unavailable task meanwhile.
      await sessions.assertSessionWorkspaceLinked(args.sessionId);
      ({ session, provider } = await resolveSessionProvider(
        ctx,
        args.sessionId,
      ));
      ctx.signal.throwIfAborted();
    }

    // Idempotent start: archived sessions throw inside start(); active ones are
    // a cheap no-op. We start unless already in a live run state.
    if (session.status !== 'active' && session.status !== 'running') {
      await sessions.start(args.sessionId);
    }
    ctx.signal.throwIfAborted();

    const runtime = ctx.services.agentRuntime.getProvider(provider);
    // submitPrompt() resolves once the runtime has actually accepted the
    // prompt — started a fresh run, or queued it behind live background work —
    // not once the turn completes. That is exactly the "received and started"
    // signal we want; nothing below this line should block further.
    await runtime.submitPrompt(args.sessionId, prompt);

    const state = await runtime
      .getRuntimeState(args.sessionId)
      .catch(() => null);
    const runtimeState = state as SessionRuntimeSnapshot | null;

    let status = 'running';
    if (runtimeState) {
      if (runtimeState.sessionState === 'requires_action')
        status = 'requires_action';
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
