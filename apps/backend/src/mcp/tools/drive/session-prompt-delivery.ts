import { Logger } from '@nestjs/common';
import type {
  AgentPromptDisposition,
  AgentRuntimeProvider,
} from '../../../agent-runtime/agent-runtime.types.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';
import { ToolError } from '../../tool-registry/tool.types.js';
import { sessionAgentPrompt, sessionAgentReference } from '../../../sessions/session-agent-message.js';
import { untilSessionDeadline } from '../session-deadline.js';
import {
  describePausedQueue,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

const logger = new Logger('SessionPromptDelivery');

export function assertCanDelegatePrompt(caller: {
  planMode?: boolean | null;
  surface?: string;
}): void {
  if (caller.planMode && caller.surface !== 'agent')
    throw new ToolError({
      code: 'delegation_blocked_in_plan_mode',
      message:
        'This session is in plan mode. Starting a delegated turn requires leaving plan mode.',
      remediation:
        'Continue planning inside this session and ask the user to approve execution when the plan is ready.',
    });
}

export function assertSessionNotCancelling(
  sessions: ToolContext['services']['sessions'],
  ...sessionIds: (number | null)[]
): void {
  if (sessionIds.some(id => id !== null && sessions.delegationHandoffs?.cancellingSession(id)))
    throw new ToolError({
      code: 'session_cancellation_in_progress',
      message: 'An agent is cancelling work in this delegation.',
      remediation: 'Inspect its status before retrying.',
    });
}

export async function sessionMessage(
  prompt: string,
  ctx: ToolContext,
  delegation = false,
  messageId?: string,
): Promise<string> {
  const senderSessionId = ctx.agentSessionId;
  if (senderSessionId === null) return prompt;
  const session = await ctx.services.sessions.findOne(senderSessionId).catch(() => null);
  if (session?.id === senderSessionId)
    return sessionAgentPrompt(prompt, sessionAgentReference(session), delegation ? 'assignment' : 'message', messageId);
  const sender = `[Elevenex ${delegation ? 'delegation' : 'session message'} from session #${senderSessionId}]`;
  return `${sender}\n\n${prompt}`;
}

export async function startSessionForPrompt(
  sessions: ToolContext['services']['sessions'],
  session: { id: number; status: string },
): Promise<void> {
  if (session.status !== 'active' && session.status !== 'running')
    await sessions.start(session.id);
}

/** A receipt belongs to this send, even when prompts are identical or race with another turn. */
export function submitSessionPrompt(
  runtime: AgentRuntimeProvider,
  sessionId: number,
  prompt: string,
  options: {
    signal: AbortSignal;
    queue?: boolean;
    preferSteering?: boolean;
    requireSteering?: boolean;
    recordDelivery?: (delivery: 'accepted' | 'failed') => void;
    titlePrompt?: string;
  },
): Promise<AgentPromptDisposition | undefined> {
  options.signal.throwIfAborted();
  let detached = false;
  const record = (delivery: 'accepted' | 'failed') => {
    try {
      options.recordDelivery?.(delivery);
    } catch (error) {
      logger.error(
        `Could not record prompt delivery session=${sessionId}: ${String(error)}`,
      );
    }
  };
  const submission = new Promise<AgentPromptDisposition>((resolve, reject) => {
    let accepted = false;
    void runtime
      .submitPrompt(sessionId, prompt, options.titlePrompt, undefined, {
        waitForCompletion: false,
        queue: options.queue,
        ...(options.preferSteering ? { preferSteering: true } : {}),
        ...(options.requireSteering ? { requireSteering: true } : {}),
        onAccepted: (disposition) => {
          if (accepted) return;
          accepted = true;
          record('accepted');
          resolve(disposition);
        },
      })
      .then(() => {
        if (!accepted)
          reject(new Error('The harness stopped before accepting the prompt.'));
      }, reject);
  }).catch((error) => {
    record('failed');
    if (detached)
      logger.error(
        `Prompt failed after disconnect session=${sessionId}: ${String(error)}`,
      );
    throw error;
  });
  return untilSessionDeadline(submission, 5_000, options.signal).then(
    (disposition) => {
      detached = disposition === undefined;
      options.signal.throwIfAborted();
      return disposition;
    },
  );
}

export function sessionPromptNextStep(
  status: string,
  sessionId: number,
  state?: SessionRuntimeSnapshot,
  queued = false,
): string {
  switch (status) {
    case 'not_started':
      return 'The session exists. Repeat the launch call with the same requestId and inputs to start it.';
    case 'acceptance_pending':
      return 'Prompt dispatch is still unconfirmed. Do not resend it. Use await_session_event or read_session.';
    case 'paused':
      return describePausedQueue(sessionId, state?.pendingPrompts?.length ?? 0);
    case 'requires_action':
      return 'Use get_pending_action to inspect what the session needs, then resolve_action when authorized.';
    case 'failed':
    case 'completed':
      return 'Use read_session to inspect the transcript.';
    default:
      return `Prompt accepted${queued ? ' and queued' : ''}. Use await_session_event when your next step needs the reply.`;
  }
}
