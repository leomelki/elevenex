import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { serializeSessionMention } from '../../../agent-runtime/session-mention.js';
import { sessionAgentReference } from '../../../sessions/session-agent-message.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { untilSessionDeadline } from '../session-deadline.js';
import { resolveSessionProvider } from './provider.util.js';
import {
  assertCanDelegatePrompt,
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

export const promptSessionTool = defineTool({
  name: 'prompt_session',
  title: 'Prompt session',
  costClass: 'heavy',
  mutates: true,
  description:
    'Send a prompt or follow-up to another session. Authenticated messages carry their sender session ID. Returns when the harness accepts this send or after 5s with acceptance_pending. Use await_session_event for the result; do not resend an unconfirmed prompt.',
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
    queue: z
      .boolean()
      .optional()
      .describe(
        "Queue as a new turn if busy. Omit to use the harness's normal live steering or queue behavior.",
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

    if (
      ctx.agentSessionId !== null &&
      session.delegatedBySessionId === ctx.agentSessionId
    )
      assertCanDelegatePrompt(await sessions.findOne(ctx.agentSessionId));
    ctx.signal.throwIfAborted();

    const runtime = ctx.services.agentRuntime.getProvider(provider);
    await startSessionForPrompt(sessions, session);
    const messageId = ctx.agentSessionId === null ? undefined : randomUUID();
    const disposition = await submitSessionPrompt(
      runtime,
      session.id,
      await sessionMessage(prompt, ctx, false, messageId),
      { signal: ctx.signal, queue: args.queue, titlePrompt: args.prompt },
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
