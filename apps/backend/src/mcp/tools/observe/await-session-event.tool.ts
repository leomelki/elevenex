import { z } from 'zod';
import { latestConversationReply } from '../../../agent-runtime/conversation-export.service.js';
import { sessionAgentReference } from '../../../sessions/session-agent-message.js';
import { changeSummary } from '../../../desktop-workspace/desktop-chat-changes.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from '../drive/provider.util.js';
import { untilSessionDeadline } from '../session-deadline.js';
import {
  describeQueuedWork,
  describePausedQueue,
  hasPausedQueue,
  hasQueuedWork,
  summarizeBackgroundWork,
} from '../session-runtime-state.util.js';
import { waitForSessionEvent } from './session-event-wait.js';

const DEFAULT_EVENTS = ['completed', 'requires_action', 'failed'];
const WAIT_TIMEOUT_MS = 170_000;
const REPLY_LIMIT = 8_000;

export const awaitSessionEventTool = defineTool({
  name: 'await_session_event',
  title: 'Await session event',
  costClass: 'heavy',
  description:
    'Wait for the first result or blocking decision across up to 16 other sessions. Returns the final reply by default. Use session_status for a snapshot. Completion includes queued and background work.',
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('One session to watch.'),
    sessionIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Watch these sessions until one matches. Remove handled sessions before waiting again.',
      ),
    events: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Statuses to wake on. Default ['completed','requires_action','failed']. Paused queues always wake.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(WAIT_TIMEOUT_MS)
      .default(WAIT_TIMEOUT_MS)
      .describe(
        'Max wait in ms, default 170000. On timeout, continue work or call again.',
      ),
    includeReply: z
      .boolean()
      .optional()
      .describe(
        'Defaults to true. Set false for status only. Replies include up to 8000 characters and the transcript item ID.',
      ),
  },
  handler: async (args, ctx) => {
    if ((args.sessionId === undefined) === (args.sessionIds === undefined))
      throw new ToolError({
        code: 'invalid_session_targets',
        message: 'Pass one of sessionId or sessionIds.',
      });
    const ids =
      args.sessionId === undefined
        ? [...new Set(args.sessionIds)]
        : [args.sessionId];
    if (ctx.agentSessionId !== null && ids.includes(ctx.agentSessionId))
      throw new ToolError({
        code: 'cannot_wait_for_current_session',
        message:
          'Wait on other sessions. This tool call keeps the current session active.',
      });
    const targets = await Promise.all(
      ids.map(async (id) => {
        const { session, provider } = await resolveSessionProvider(ctx, id);
        return {
          id,
          provider,
          status: session.status,
          session: sessionAgentReference(session),
          runtime: ctx.services.agentRuntime.getProvider(provider),
        };
      }),
    );
    const wanted = new Set(args.events?.length ? args.events : DEFAULT_EVENTS);
    const callerId = ctx.agentSessionId;
    const handoffs = ctx.services.sessions.delegationHandoffs;
    const release =
      callerId === null ? undefined : handoffs?.observe(callerId, ids);
    try {
      const { event, target, state, actionKey, assignmentId } =
        await waitForSessionEvent(targets, wanted, args.timeoutMs, ctx);
      if (!target)
        return {
          data: { sessionIds: ids, event, status: event },
          nextStep:
            'Continue independent work or wait again on the remaining sessions.',
        };

      const backgroundWork = summarizeBackgroundWork(state);
      const paused = hasPausedQueue(state);
      const pending = state?.pendingPrompts?.length ?? 0;
      const turnEnded =
        state?.sessionState === 'idle' && state.runPhase === 'idle';
      const assignedReply =
        callerId === null ||
        event !== 'completed' ||
        args.includeReply === false
          ? undefined
          : handoffs?.outbox.latestReply(target.id, callerId, assignmentId);
      const outcome =
        event === 'completed' && args.includeReply !== false
          ? assignedReply?.promptId
            ? {
                item: assignedReply.replyId
                  ? {
                      id: assignedReply.replyId,
                      content: assignedReply.replyText ?? undefined,
                    }
                  : undefined,
                changes: undefined,
              }
            : await untilSessionDeadline(
                target.runtime
                  .getHistory(target.id, { changeDetails: 'summary' })
                  .then((history) => {
                    const item = latestConversationReply(history);
                    const boundary = history.findLastIndex(
                      (row) => row.kind === 'user',
                    );
                    let changes;
                    for (let at = history.length - 1; at > boundary; at--) {
                      if (history[at].turnChanges) {
                        changes = changeSummary(history[at].turnChanges, 3);
                        break;
                      }
                    }
                    return { item, changes };
                  })
                  .catch(() => undefined),
                1_500,
                ctx.signal,
              )
          : undefined;
      const item = outcome?.item;
      const text = item?.content?.trim();
      const session = targets.find((row) => row.id === target.id)?.session;
      const changes = outcome?.changes;
      const reply =
        item && text
          ? {
              id: item.id,
              text: text.slice(0, REPLY_LIMIT),
              truncated: text.length > REPLY_LIMIT,
              ...(changes?.files.length ? { changes } : {}),
            }
          : undefined;

      let nextStep: string;
      switch (event) {
        case 'paused':
          nextStep = describePausedQueue(target.id, pending);
          break;
        case 'requires_action':
          nextStep =
            'Use get_pending_action to inspect what the session needs, then resolve_action when authorized.';
          break;
        case 'timeout':
          nextStep =
            'Still waiting. Call await_session_event again or continue independent work.';
          if (
            turnEnded &&
            hasQueuedWork(state) &&
            (pending || backgroundWork.length)
          )
            nextStep += ` Its turn has ended. ${describeQueuedWork(backgroundWork, pending)}`;
          break;
        case 'provider_changed':
          nextStep =
            'The target harness changed. Inspect the session or wait again on its new harness.';
          break;
        case 'aborted':
          nextStep =
            'Use session_status or begin another wait to continue observing.';
          break;
        default:
          nextStep =
            reply && !reply.truncated
              ? 'Use prompt_session for a focused follow-up or read_session for more context.'
              : 'Use read_session to inspect the transcript.';
      }

      if (callerId !== null && !ctx.signal.aborted) {
        if (reply) handoffs?.returned(target.id, reply.id, callerId);
        if (event === 'requires_action' && actionKey)
          handoffs?.acknowledgedAction(target.id, callerId, actionKey);
        if (reply || (event === 'failed' && assignmentId !== undefined))
          handoffs?.collected(
            target.id,
            callerId,
            reply?.id,
            reply ? undefined : assignmentId,
          );
      }

      return {
        data: {
          sessionId: target.id,
          ...(assignmentId !== undefined ? { assignmentId } : {}),
          ...(session ? { session } : {}),
          event,
          status: event,
          ...(reply && { reply }),
          ...(backgroundWork.length ? { backgroundWork } : {}),
          ...(paused ? { queuePaused: true, pendingPromptCount: pending } : {}),
        },
        deepLink: ctx.deepLink.session(target.id),
        nextStep:
          nextStep +
          (paused && event !== 'paused'
            ? ` ${describePausedQueue(target.id, pending)}`
            : ''),
        truncated: reply?.truncated,
      };
    } finally {
      release?.();
    }
  },
});
