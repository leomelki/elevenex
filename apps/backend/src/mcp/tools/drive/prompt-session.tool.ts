import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { attachSessionMentions, sessionMentionIds } from './session-prompt-context.js';
import { sessionAgentReference } from '../../../sessions/session-agent-message.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { untilSessionDeadline } from '../session-deadline.js';
import { resolveSessionProvider } from './provider.util.js';
import {
  assertCanDelegatePrompt,
  assertSessionNotCancelling,
  sessionMessage,
  sessionPromptNextStep,
  startSessionForPrompt,
  submitSessionPrompt,
} from './session-prompt-delivery.js';
import {
  isSessionSettled,
  hasPausedQueue,
  getSessionAttentionStatus,
  describePausedQueue,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

function requirePromptableProvider(provider: string): void {
  if (provider === 'antigravity') {
    throw new ToolError({
      code: 'interactive_provider',
      message: 'Antigravity accepts messages sent directly from desktop chat.',
      remediation: 'Open the Antigravity session in the desktop app to send a message.',
    });
  }
}

export const promptSessionTool = defineTool({
  name: 'prompt_session',
  title: 'Prompt session',
  costClass: 'heavy',
  mutates: true,
  description:
    'Send a follow-up to another session by ID. Starts an idle session, steers a live turn when supported, or queues. Use mode to explicitly queue, require live steering, or restart. Authenticated sends carry the sender session ID. Returns the delivery disposition or acceptance_pending after 5s. Use await_session_event for the result; do not resend an unconfirmed prompt.',
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
      .trim()
      .min(1)
      .describe(
        'The instruction to send to the agent. Required, non-empty. Keep each prompt scoped to one coherent concern (one feature/fix/investigation) rather than bundling unrelated work — split unrelated concerns across separate prompts or sessions to avoid long, tangled sessions.',
      ),
    mode: z.enum(['auto', 'queue', 'steer', 'restart']).optional().describe(
      'Auto starts an idle session, prefers steering or queues. Queue waits for a separate turn. Steer requires a live turn. Restart interrupts the current turn before sending and requires an empty queue.',
    ),
    mentionSessionIds: sessionMentionIds,
  },
  handler: async (args, ctx) => {
    const mode = args.mode ?? 'auto';
    const { sessions } = ctx.services;
    await sessions.assertSessionWorkspaceLinked(args.sessionId);
    let { session, provider } = await resolveSessionProvider(
      ctx,
      args.sessionId,
    );
    requirePromptableProvider(provider);

    const mentionSessionIds = [...new Set(args.mentionSessionIds ?? [])];
    const prompt = await attachSessionMentions(args.prompt, mentionSessionIds, ctx, args.sessionId);
    ctx.signal.throwIfAborted();

    if (mentionSessionIds.length) {
      // Reading source histories can be slow. The target may have been
      // archived, reconfigured, or moved to an unavailable task meanwhile.
      await sessions.assertSessionWorkspaceLinked(args.sessionId);
      ({ session, provider } = await resolveSessionProvider(
        ctx,
        args.sessionId,
      ));
      requirePromptableProvider(provider);
      ctx.signal.throwIfAborted();
    }

    if (
      ctx.agentSessionId !== null &&
      session.delegatedBySessionId === ctx.agentSessionId
    )
      assertCanDelegatePrompt(await sessions.findOne(ctx.agentSessionId));
    ctx.signal.throwIfAborted();

    const runtime = ctx.services.agentRuntime.getProvider(provider);
    assertSessionNotCancelling(sessions, session.id, ctx.agentSessionId);
    if (mode === 'restart') {
      const state = await runtime.getRuntimeState(session.id, { initialize: false });
      if (hasPausedQueue(state) || state.pendingPrompts?.length || state.dispatchingPrompts?.length)
        throw new ToolError({
          code: 'restart_queue_not_empty',
          message: 'Resolve the existing prompt queue before requesting restart.',
        });
      ctx.signal.throwIfAborted();
      assertSessionNotCancelling(sessions, session.id, ctx.agentSessionId);
      if (!isSessionSettled(state) && (session.status === 'active' || session.status === 'running'))
        await runtime.interrupt(session.id);
      ctx.signal.throwIfAborted();
    }
    if (mode !== 'steer') await startSessionForPrompt(sessions, session);
    const messageId = ctx.agentSessionId === null ? undefined : randomUUID();
    const message = await sessionMessage(prompt, ctx, false, messageId);
    assertSessionNotCancelling(sessions, session.id, ctx.agentSessionId);
    const disposition = await submitSessionPrompt(
      runtime,
      session.id,
      message,
      {
        signal: ctx.signal,
        queue: mode === 'queue' || mode === 'restart',
        preferSteering: mode === 'auto' || mode === 'steer',
        requireSteering: mode === 'steer',
        titlePrompt: args.prompt,
      },
    );
    // The receipt proves acceptance. This single bounded read only augments
    // its result with a pause, pending decision or an already completed turn.
    const runtimeState: SessionRuntimeSnapshot | undefined = disposition
      ? await untilSessionDeadline(
          runtime
            .getRuntimeState(session.id, { initialize: false })
            .catch(() => undefined),
          150,
          ctx.signal,
        )
      : undefined;
    const paused = hasPausedQueue(runtimeState);
    const pendingPromptCount = runtimeState?.pendingPrompts?.length ?? 0;
    const status = disposition
      ? (getSessionAttentionStatus(runtimeState) ??
        (isSessionSettled(runtimeState) ? 'completed' : 'running'))
      : 'acceptance_pending';

    return {
      data: {
        sessionId: session.id,
        session: sessionAgentReference(session),
        accepted: disposition !== undefined,
        ...(messageId ? { messageId } : {}),
        provider,
        status,
        ...(disposition && { disposition }),
        ...(disposition === 'queued' && { queued: true }),
        ...(paused && { queuePaused: true, pendingPromptCount }),
      },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        sessionPromptNextStep(
          status,
          session.id,
          runtimeState,
          disposition === 'queued',
        ) +
        (paused && status !== 'paused'
          ? ` ${describePausedQueue(session.id, pendingPromptCount)}`
          : ''),
    };
  },
});
