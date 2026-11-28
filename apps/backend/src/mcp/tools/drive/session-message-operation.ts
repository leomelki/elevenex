import { createHash, randomUUID } from 'node:crypto';
import type { AgentPromptDisposition } from '../../../agent-runtime/agent-runtime.types.js';
import { attachSessionMentions } from './session-prompt-context.js';
import {
  sessionAgentPrompt,
  sessionAgentReference,
} from '../../../sessions/session-agent-message.js';
import { ToolError, type ToolContext } from '../../tool-registry/tool.types.js';
import { untilSessionDeadline } from '../session-deadline.js';
import { resolveSessionProvider } from './provider.util.js';
import {
  assertCanDelegatePrompt,
  assertSessionNotCancelling,
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

export interface SessionMessageInput {
  sessionId: number;
  prompt: string;
  mode?: 'auto' | 'queue' | 'steer' | 'restart';
  mentionSessionIds?: number[];
  requestId?: string;
  notifyOnCompletion?: boolean;
}

function requirePromptableProvider(provider: string): void {
  if (provider === 'antigravity') {
    throw new ToolError({
      code: 'interactive_provider',
      message: 'Antigravity accepts messages sent directly from desktop chat.',
      remediation:
        'Open the Antigravity session in the desktop app to send a message.',
    });
  }
}

/** Shared delivery boundary for assignments and ordinary inter-agent messages. */
export async function deliverSessionMessage(
  args: SessionMessageInput,
  ctx: ToolContext,
  options: { resumeStopped?: boolean } = {},
) {
  const mode = args.mode ?? 'auto';
  const { sessions } = ctx.services;
  await sessions.assertSessionWorkspaceLinked(args.sessionId);
  let { session, provider } = await resolveSessionProvider(ctx, args.sessionId);
  requirePromptableProvider(provider);

  if (args.sessionId === ctx.agentSessionId)
    throw new ToolError({
      code: 'self_target_not_allowed',
      message: 'Send messages to another session.',
    });
  const caller =
    ctx.agentSessionId === null
      ? null
      : await sessions.findOne(ctx.agentSessionId).catch(() => null);
  const delegated =
    caller !== null && session.delegatedBySessionId === ctx.agentSessionId;
  const notify = args.notifyOnCompletion ?? delegated;
  if (notify && !delegated)
    throw new ToolError({
      code: 'not_your_delegate',
      message: 'Automatic completion requires your own delegated session.',
    });
  const canNotify = notify && caller?.activeAgentProvider !== 'antigravity';
  const mentionSessionIds = [...new Set(args.mentionSessionIds ?? [])];
  const hash = (fields: readonly unknown[]) =>
    createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  const fingerprint = hash([args.prompt, mode, mentionSessionIds, notify]);
  const key = hash([
    ctx.agentSessionId,
    args.sessionId,
    args.requestId ?? randomUUID(),
  ]);
  const prompts = sessions.delegationHandoffs?.prompts;
  const tracked = args.requestId !== undefined || notify;
  const prior = tracked ? prompts.read(key, fingerprint) : undefined;
  const receiptResult = (receipt: NonNullable<typeof prior>) => {
    const assignment = notify
      ? sessions.delegationHandoffs.outbox.assignment(receipt.id)
      : undefined;
    return {
      data: {
        sessionId: session.id,
        session: sessionAgentReference(session),
        messageId: receipt.id,
        provider,
        accepted: receipt.delivery === 'accepted',
        deliveryState: receipt.delivery,
        ...(receipt.disposition ? { disposition: receipt.disposition } : {}),
        status:
          receipt.delivery === 'failed'
            ? 'failed'
            : receipt.delivery === 'accepted'
              ? (assignment?.outcome ?? (notify ? 'running' : 'accepted'))
              : 'acceptance_pending',
        ...(assignment
          ? {
              assignmentId: assignment.assignmentId,
              completionState: assignment.state,
            }
          : {}),
        ...(notify ? { completion: canNotify ? 'notify' : 'wait' } : {}),
      },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        receipt.delivery === 'failed'
          ? 'This send failed. Inspect the session before starting a new request.'
          : receipt.delivery !== 'accepted'
            ? 'Acceptance is unconfirmed. Inspect the recipient; do not resend with a different requestId.'
            : canNotify
              ? 'This assignment reports back automatically. Continue independent work and end your turn when none remains.'
              : notify
                ? 'Use await_session_event to collect this assignment; this parent requires an explicit desktop send to start another turn.'
                : 'The message was accepted. No automatic reply is requested. Read the recipient if you need more context.',
    };
  };
  if (prior) return receiptResult(prior);
  if (
    options.resumeStopped === false &&
    [caller?.status, session.status].some(
      (status) => status === 'archived' || status === 'stopped',
    )
  )
    throw new ToolError({
      code: 'session_messaging_stopped',
      message:
        'Messages cannot resume explicitly stopped or archived conversations. Ask the user to resume the work.',
    });
  const prompt = await attachSessionMentions(
    args.prompt,
    mentionSessionIds,
    ctx,
    args.sessionId,
  );
  ctx.signal.throwIfAborted();

  if (mentionSessionIds.length) {
    // Reading source histories can be slow. The target may have been
    // archived, reconfigured, or moved to an unavailable task meanwhile.
    await sessions.assertSessionWorkspaceLinked(args.sessionId);
    ({ session, provider } = await resolveSessionProvider(ctx, args.sessionId));
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
  if (notify && caller) assertCanDelegatePrompt(caller);
  const messageId = ctx.agentSessionId === null ? undefined : randomUUID();
  const reserved = tracked
    ? prompts.reserve({
        id: messageId ?? randomUUID(),
        key,
        fingerprint,
        sessionId: session.id,
        senderId: ctx.agentSessionId,
        delivery: 'dispatching',
      })
    : undefined;
  if (reserved && !reserved.created) return receiptResult(reserved.receipt);
  let dispatched = false;
  try {
    if (mode === 'restart') {
      const state = await runtime.getRuntimeState(session.id, {
        initialize: false,
      });
      if (
        hasPausedQueue(state) ||
        state.pendingPrompts?.length ||
        state.dispatchingPrompts?.length
      )
        throw new ToolError({
          code: 'restart_queue_not_empty',
          message:
            'Resolve the existing prompt queue before requesting restart.',
        });
      ctx.signal.throwIfAborted();
      assertSessionNotCancelling(sessions, session.id, ctx.agentSessionId);
      if (
        !isSessionSettled(state) &&
        (session.status === 'active' || session.status === 'running')
      )
        await runtime.interrupt(session.id);
      ctx.signal.throwIfAborted();
    }
    if (mode !== 'steer') await startSessionForPrompt(sessions, session);
    ctx.signal.throwIfAborted();
    if (notify && reserved) prompts.arm(reserved.receipt.id);
    const message =
      caller?.id === ctx.agentSessionId
        ? sessionAgentPrompt(
            prompt,
            sessionAgentReference(caller),
            notify ? 'assignment' : 'message',
            messageId,
          )
        : ctx.agentSessionId === null
          ? prompt
          : `[Elevenex session message from session #${ctx.agentSessionId}]\n\n${prompt}`;
    assertSessionNotCancelling(sessions, session.id, ctx.agentSessionId);
    dispatched = true;
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
        ...(reserved
          ? {
              recordDelivery: (
                delivery: 'accepted' | 'failed',
                disposition?: AgentPromptDisposition,
              ) => prompts.record(reserved.receipt.id, delivery, disposition),
            }
          : {}),
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
        ...(reserved
          ? { deliveryState: disposition ? 'accepted' : 'dispatching' }
          : {}),
        ...(notify
          ? {
              completion: canNotify ? 'notify' : 'wait',
              assignmentId: reserved
                ? sessions.delegationHandoffs.outbox.assignment(
                    reserved.receipt.id,
                  )?.assignmentId
                : undefined,
            }
          : {}),
        ...(messageId ? { messageId } : {}),
        provider,
        status,
        ...(disposition && { disposition }),
        ...(disposition === 'queued' && { queued: true }),
        ...(paused && { queuePaused: true, pendingPromptCount }),
      },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        (paused || status === 'requires_action' || status === 'failed'
          ? sessionPromptNextStep(
              status,
              session.id,
              runtimeState,
              disposition === 'queued',
            )
          : canNotify && disposition
            ? 'This assignment reports back automatically when the delegate finishes or needs a decision. Continue independent work and end your turn when none remains.'
            : args.notifyOnCompletion === false && disposition
              ? 'Message accepted. No automatic reply is requested; continue your assignment. Send questions or answers with send_session_message.'
              : sessionPromptNextStep(
                  status,
                  session.id,
                  runtimeState,
                  disposition === 'queued',
                )) +
        (paused && status !== 'paused'
          ? ` ${describePausedQueue(session.id, pendingPromptCount)}`
          : ''),
    };
  } catch (error) {
    if (reserved && !dispatched) prompts.record(reserved.receipt.id, 'failed');
    throw error;
  }
}
