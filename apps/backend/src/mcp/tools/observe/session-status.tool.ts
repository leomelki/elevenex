import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  describeQueuedWork,
  describePausedQueue,
  hasPausedQueue,
  getSessionAttentionStatus,
  hasQueuedWork,
  summarizeBackgroundWork,
  type BackgroundWorkSummary,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

/**
 * session_status — the cheap liveness poll that GATES heavier reads. ⚡instant:
 * one DB row plus the runtime's live state, NO transcript. Tells you whether a
 * session moved, needs review, or is blocked on a pending action so you only
 * spend tokens on read_session / get_pending_action when there's something new.
 */
export const sessionStatusTool = defineTool({
  name: 'session_status',
  title: 'Session status',
  costClass: 'instant',
  description:
    'Cheap liveness poll for one session (DB status + live runtime state, no transcript). ⚡instant. Gate before reading: call read_session when items advanced, get_pending_action when hasPendingAction, or await_session_event to block on a change. `hasQueuedWork:true` means unfinished background work or queued prompts remain; `queuePaused:true` means queued prompts need an explicit resume_pending_prompts call and will not resume automatically; `backgroundWork` lists what is still running, and `orphaned` items were left behind by a finished subagent (stop_background_task ends one).',
  annotations: { readOnlyHint: true },
  currentSessionScope: 'session',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe(
        'Session id to poll. Get ids from project_overview / find_sessions.',
      ),
  },
  handler: async (args, ctx) => {
    const { sessions, agentRuntime } = ctx.services;

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

    // Live runtime state is best-effort: the runtime may not be started yet, in
    // which case we fall back to the DB status and report no pending action.
    let runtimeState: string | undefined;
    let hasPendingAction = false;
    let queuedWork = false;
    let backgroundWork: BackgroundWorkSummary[] = [];
    let pendingPromptCount = 0;
    let queuePaused = false;
    let pausedQueue = false;
    let attention: ReturnType<typeof getSessionAttentionStatus> = null;
    try {
      const provider = agentRuntime.getProvider(session.activeAgentProvider);
      const state = (await provider.getRuntimeState(
        args.sessionId,
      )) as SessionRuntimeSnapshot & {
        pendingPermissionRequest?: unknown;
        pendingUserInputRequest?: unknown;
      };
      queuedWork = hasQueuedWork(state);
      queuePaused = state.queuePaused === true;
      pausedQueue = hasPausedQueue(state);
      attention = getSessionAttentionStatus(state);
      backgroundWork = summarizeBackgroundWork(state);
      pendingPromptCount = state.pendingPrompts?.length ?? 0;
      // A paused queue needs explicit intervention. Unpaused queued work can
      // resume an idle visible turn automatically.
      runtimeState =
        attention === 'requires_action' || attention === 'failed'
          ? attention
          : pausedQueue &&
              state.sessionState !== 'running' &&
              state.sessionState !== 'requires_action' &&
              state.runPhase !== 'running'
            ? 'paused'
            : queuedWork &&
                state.sessionState === 'idle' &&
                state.runPhase === 'idle'
              ? 'running'
              : (state.sessionState ??
                (state.runPhase === 'running' ? 'running' : undefined) ??
                undefined);
      hasPendingAction =
        state.sessionState === 'requires_action' ||
        !!state.pendingPermissionRequest ||
        !!state.pendingUserInputRequest;
    } catch {
      runtimeState = undefined;
    }

    return {
      data: {
        sessionId: session.id,
        status: session.status,
        runtimeState: runtimeState ?? session.status,
        needsReview: session.hasUnreviewedCompletion,
        hasPendingAction,
        hasQueuedWork: queuedWork,
        queuePaused,
        pendingPromptCount,
        ...(backgroundWork.length ? { backgroundWork } : {}),
        lastActivityAt: session.lastStateChangeAt ?? undefined,
      },
      deepLink: ctx.deepLink.session(session.id),
      nextStep: hasPendingAction
        ? `Blocked: inspect with get_pending_action, then resolve it.${pausedQueue ? ` ${describePausedQueue(session.id, pendingPromptCount)}` : ''}`
        : attention === 'failed'
          ? `Session failed. Call read_session for details.${pausedQueue ? ` ${describePausedQueue(session.id, pendingPromptCount)}` : ''}`
          : pausedQueue
            ? describePausedQueue(session.id, pendingPromptCount)
            : queuedWork
              ? `Not actually idle: a background task or queued prompt will resume this session. await_session_event or poll_session_status to wait for real completion — do not treat this as done. ${describeQueuedWork(backgroundWork, pendingPromptCount)}`
              : 'If items advanced, read_session for the delta; else await_session_event to block on a change.',
    };
  },
});
