import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentRuntimeProvider } from '../../../agent-runtime/agent-runtime.types.js';
import { serializeSessionMention } from '../../../agent-runtime/session-mention.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';
import {
  isSessionSettled,
  hasPausedQueue,
  getSessionAttentionStatus,
  describePausedQueue,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

const ACCEPTANCE_TIMEOUT_MS = 5_000;
const ACCEPTANCE_LIFECYCLE_EVENTS = new Set([
  'runtime_status',
  'complete',
  'result',
  'history_snapshot',
  'history',
  'background_work',
  'terminal',
  'interrupted',
  'stopped',
  'closed',
]);
const logger = new Logger('PromptSessionTool');
type AcceptanceSnapshot = Omit<SessionRuntimeSnapshot, 'pendingPrompts'> & {
  liveItems?: { id: string; kind: string; content?: string }[];
  pendingPrompts?: { id: string; prompt: string }[];
};

/** Bound the baseline read too; an unavailable baseline cannot prove a new turn. */
function readBaseline(
  readState: () => Promise<AcceptanceSnapshot>,
  signal: AbortSignal,
) {
  return new Promise<AcceptanceSnapshot | null>((resolve) => {
    let settled = false;
    const finish = (state: AcceptanceSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(state);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), 250);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void readState().then(
      (state) => finish(state),
      () => finish(null),
    );
  });
}

async function submitUntilAccepted(
  runtime: AgentRuntimeProvider,
  sessionId: number,
  prompt: string,
  signal: AbortSignal,
): Promise<{
  accepted: boolean;
  state: AcceptanceSnapshot | null;
  queued: boolean;
}> {
  const deadline = Date.now() + ACCEPTANCE_TIMEOUT_MS;
  let inFlight: Promise<AcceptanceSnapshot> | null = null;
  const readState = (): Promise<AcceptanceSnapshot> => {
    if (inFlight) return inFlight;
    const read = Promise.resolve().then(() =>
      runtime.getRuntimeState(sessionId),
    );
    inFlight = read.then(
      (state) => {
        inFlight = null;
        return state as AcceptanceSnapshot;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };
  const baseline = await readBaseline(readState, signal);
  signal.throwIfAborted();
  // Copy identities before dispatch: provider snapshots can be mutable.
  const pendingIds = new Set(baseline?.pendingPrompts?.map((item) => item.id));
  const liveIds = new Set(baseline?.liveItems?.map((item) => item.id));
  const wasSettled = isSessionSettled(baseline);

  return new Promise((resolve, reject) => {
    let settled = false;
    let confirmed = false;
    let checking = false;
    let recheck = false;
    let latest: AcceptanceSnapshot | null = null;
    let poll: NodeJS.Timeout | undefined;
    let receiptTimer: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(poll);
      clearTimeout(receiptTimer);
      runtime.off('event', onEvent);
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else
        resolve({
          accepted: confirmed,
          state: latest,
          queued:
            confirmed &&
            Boolean(
              latest?.pendingPrompts?.some(
                (item) =>
                  !pendingIds.has(item.id) &&
                  item.prompt?.trim() === prompt.trim(),
              ),
            ),
        });
    };
    const observe = (state: AcceptanceSnapshot) => {
      latest = state;
      if (
        baseline &&
        (state.pendingPrompts?.some(
          (item) =>
            !pendingIds.has(item.id) && item.prompt?.trim() === prompt.trim(),
        ) ||
          state.liveItems?.some(
            (item) =>
              !liveIds.has(item.id) &&
              item.kind === 'user' &&
              item.content?.trim() === prompt.trim(),
          ) ||
          (wasSettled &&
            (state.sessionState === 'running' ||
              state.runPhase === 'running' ||
              state.sessionState === 'requires_action')))
      )
        confirmed = true;
      if (confirmed) finish();
    };
    const check = () => {
      if (settled) return;
      if (checking) {
        recheck = true;
        return;
      }
      clearTimeout(poll);
      checking = true;
      recheck = false;
      const hadReceipt = confirmed;
      void readState().then(
        (state) => {
          checking = false;
          if (settled) return;
          // A read begun before the receipt may still describe the old turn.
          if (!confirmed || hadReceipt) observe(state as AcceptanceSnapshot);
          if (settled) return;
          if (recheck || confirmed) check();
          else poll = setTimeout(check, 1_000);
        },
        () => {
          checking = false;
          if (!settled) poll = setTimeout(check, 1_000);
        },
      );
    };
    const onEvent = (event: {
      type: string;
      payload: AcceptanceSnapshot & {
        sessionId: number;
        message?: string;
        lastError?: string | null;
      };
    }) => {
      if (event.payload.sessionId !== sessionId || settled) return;
      if (event.type === 'error') {
        finish(
          new Error(
            event.payload.message ??
              event.payload.lastError ??
              'Prompt failed.',
          ),
        );
      } else if (
        event.type === 'run_state' ||
        event.type === 'runtime_snapshot'
      ) {
        observe(event.payload);
      } else if (ACCEPTANCE_LIFECYCLE_EVENTS.has(event.type)) check();
    };
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(
      () => finish(),
      Math.max(0, deadline - Date.now()),
    );
    runtime.on('event', onEvent);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      // Provider contracts differ: a receipt can resolve now, or the promise
      // can cover the full turn. Both rejection paths stay observed after return.
      void runtime.submitPrompt(sessionId, prompt).then(
        () => {
          if (settled) return;
          confirmed = true;
          latest = null;
          // Returning acceptance must not wait on a hung follow-up state read.
          receiptTimer = setTimeout(() => finish(), 100);
          check();
        },
        (error: unknown) => {
          if (settled)
            logger.error(
              `Prompt failed session=${sessionId}: ${String(error)}`,
            );
          else finish(error);
        },
      );
      check();
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * prompt_session — trigger or continue a session's agent with a prompt. Ensures
 * the session is started, submits the prompt, and returns as soon as the
 * runtime has accepted it (or queued it), with a bounded unconfirmed result
 * if no receipt can be observed. It never blocks waiting for the
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
    "Send a prompt to a session's agent, optionally mentioning previous sessions with compact snapshots and transcript paths (like chat mentions). 🔴heavy. Starts the session if needed, submits the prompt, and returns once acceptance is confirmed (or after 5s with accepted:false / acceptance_pending; do not resubmit) — it does NOT wait for the turn to finish, so you can prompt_session other sessions right away instead of waiting on this one. Call poll_session_status or await_session_event when you actually need to wait for this session. Resolve any permission prompts with get_pending_action → resolve_action.",
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
    const acceptance = await submitUntilAccepted(
      runtime,
      args.sessionId,
      prompt,
      ctx.signal,
    );
    const runtimeState = acceptance.state;

    let status = acceptance.accepted ? 'running' : 'acceptance_pending';
    if (acceptance.accepted && runtimeState) {
      const attention = getSessionAttentionStatus(runtimeState);
      if (attention) status = attention;
      else if (isSessionSettled(runtimeState)) status = 'completed';
    }

    const nextStep = !acceptance.accepted
      ? 'Prompt dispatched, but acceptance is still unconfirmed. Do not resubmit: call poll_session_status or read_session to check it.'
      : status === 'paused'
        ? describePausedQueue(
            args.sessionId,
            runtimeState?.pendingPrompts?.length ?? 0,
          )
        : status === 'requires_action'
          ? 'Session blocked: get_pending_action to inspect, then resolve_action.'
          : status === 'failed'
            ? 'Session finished. Call read_session for the transcript.'
            : status === 'completed'
              ? 'Session finished already (fast turn). Call read_session for the transcript.'
              : acceptance.queued
                ? 'Prompt accepted and queued. Call poll_session_status or await_session_event to follow its progress.'
                : 'Prompt accepted; the session is working in the background. Call poll_session_status or await_session_event to wait for it — or prompt_session other sessions now rather than waiting on this one.';

    return {
      data: {
        sessionId: args.sessionId,
        accepted: acceptance.accepted,
        provider,
        status,
        ...(acceptance.queued ? { queued: true } : {}),
        ...(hasPausedQueue(runtimeState)
          ? {
              queuePaused: true,
              pendingPromptCount: runtimeState!.pendingPrompts!.length,
            }
          : {}),
      },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep:
        nextStep +
        (hasPausedQueue(runtimeState) && status !== 'paused'
          ? ` ${describePausedQueue(args.sessionId, runtimeState!.pendingPrompts!.length)}`
          : ''),
    };
  },
});
