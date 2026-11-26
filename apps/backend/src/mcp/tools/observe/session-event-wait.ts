import type { AgentRuntimeProvider } from '../../../agent-runtime/agent-runtime.types.js';
import type { SessionLaunchDelivery } from '../../../sessions/session-creation.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';
import { untilSessionDeadline } from '../session-deadline.js';
import {
  getSessionAttentionStatus,
  hasPausedQueue,
  isSessionSettled,
  pendingActionKey,
  type SessionRuntimeSnapshot,
} from '../session-runtime-state.util.js';

const TERMINAL_DB_STATUSES = new Set(['archived', 'stopped']);

export interface SessionEventTarget {
  id: number;
  provider: string;
  status: string;
  runtime: AgentRuntimeProvider;
}

interface WatchedSession extends SessionEventTarget {
  delivery: SessionLaunchDelivery;
  state?: SessionRuntimeSnapshot;
  actionKey?: string | null;
  revision: number;
  readPending: boolean;
  readAgain: boolean;
}

export interface SessionEventResult {
  event: string;
  assignmentId?: number;
  target?: SessionEventTarget;
  actionKey?: string | null;
  state?: SessionRuntimeSnapshot;
}

/** Wait across harnesses with one deadline and detach every target on the first result. */
export function waitForSessionEvent(
  targets: readonly SessionEventTarget[],
  wanted: ReadonlySet<string>,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<SessionEventResult> {
  const { sessions, sessionEvents } = ctx.services;
  const watched: WatchedSession[] = targets.map((target) => ({
    ...target,
    delivery: null,
    revision: 0,
    readPending: false,
    readAgain: false,
  }));
  return new Promise((resolve) => {
    let finished = false;
    const release: (() => void)[] = [];
    const finish = (result: SessionEventResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', abort);
      for (const dispose of release) dispose();
      resolve(result);
    };
    const single = watched.length === 1 ? watched[0] : undefined;
    const abort = () => finish({ event: 'aborted', target: single });
    const timer = setTimeout(() => {
      if (!single) {
        finish({ event: 'timeout' });
        return;
      }
      // Preserve the single-session timeout diagnostics if a provider has
      // changed its pause/attention state without publishing a snapshot.
      if (single.readPending) {
        finish({ event: 'timeout', target: single, state: single.state });
        return;
      }
      void untilSessionDeadline(
        sessionEvents.readState(single.runtime, single.id),
        150,
        ctx.signal,
      ).then((state) => {
        const latest = state ?? single.state;
        const attention = hasPausedQueue(latest)
          ? getSessionAttentionStatus(latest)
          : null;
        finish({
          event: attention ?? 'timeout',
          target: single,
          state: latest,
        });
      });
    }, timeoutMs);

    const consider = (
      target: WatchedSession,
      state?: SessionRuntimeSnapshot,
    ) => {
      if (finished) return;
      if (state) {
        target.actionKey = pendingActionKey(state);
        // Hold only lifecycle data. The source may carry a large live transcript.
        const {
          sessionState,
          runPhase,
          pendingPrompts,
          queuePaused,
          backgroundWork,
          dispatchingPrompts,
          tasks,
        } = state;
        target.state = {
          sessionState,
          runPhase,
          pendingPrompts,
          queuePaused,
          backgroundWork,
          dispatchingPrompts,
          tasks,
        };
      }
      const terminal =
        TERMINAL_DB_STATUSES.has(target.status) || target.delivery === 'failed';
      const attention = getSessionAttentionStatus(target.state);
      const launchPending =
        target.delivery === 'ready' || target.delivery === 'dispatching';
      const assignment =
        ctx.agentSessionId === null
          ? undefined
          : sessions.delegationHandoffs?.outbox.status(
              target.id,
              ctx.agentSessionId,
            );
      const assignmentPending =
        assignment?.promptId && assignment.state === 'waiting';
      const event = terminal
        ? 'failed'
        : assignment?.outcome === 'failed'
          ? 'failed'
          : (attention ??
            (!launchPending &&
            !assignmentPending &&
            isSessionSettled(target.state)
              ? 'completed'
              : null));
      if (
        event &&
        (event === 'paused' ||
          wanted.has(event) ||
          hasPausedQueue(target.state))
      )
        finish({
          event,
          target,
          state: target.state,
          actionKey: target.actionKey,
          assignmentId: assignment?.assignmentId,
        });
    };

    const inspect = (target: WatchedSession) => {
      if (finished) return;
      if (target.readPending) {
        target.readAgain = true;
        return;
      }
      target.readPending = true;
      const revision = target.revision;
      void sessionEvents.readState(target.runtime, target.id).then((state) => {
        target.readPending = false;
        if (revision === target.revision) consider(target, state);
        if (target.readAgain) {
          target.readAgain = false;
          inspect(target);
        }
      });
    };

    ctx.signal.addEventListener('abort', abort, { once: true });
    if (ctx.signal.aborted) {
      abort();
      return;
    }
    for (const target of watched) {
      release.push(
        sessionEvents.handoff.subscribe(sessions, target.id, () =>
          inspect(target),
        ),
        sessionEvents.status.subscribe(sessions, target.id, ({ status }) => {
          target.status = status;
          consider(target);
        }),
        sessionEvents.provider.subscribe(sessions, target.id, () => {
          finish({ event: 'provider_changed', target });
        }),
        sessionEvents.launch.subscribe(sessions, target.id, ({ delivery }) => {
          target.delivery = delivery;
          target.revision++;
          consider(
            target,
            delivery === 'accepted'
              ? {
                  sessionState: 'running',
                  runPhase: 'running',
                }
              : undefined,
          );
          if (delivery === 'accepted') inspect(target);
        }),
        sessionEvents.watchRuntime(
          target.runtime,
          target.id,
          ({ type, payload }) => {
            if (type === 'run_state' || type === 'runtime_snapshot') {
              target.revision++;
              consider(target, payload);
            } else if (type === 'error') {
              target.revision++;
              consider(target, {
                ...target.state,
                ...payload,
                runPhase: 'error',
                sessionState: 'idle',
              });
            } else if (type === 'complete' || type === 'background_work') {
              target.revision++;
              inspect(target);
            }
          },
        ),
      );
      target.delivery = sessions.getSessionLaunchDelivery(target.id);
      consider(target);
      if (finished) break;
      // Subscribe first so a fast turn or an archive during hydration wakes us.
      void sessions.findOne(target.id).then(
        (current) => {
          if (finished) return;
          if (current.activeAgentProvider !== target.provider) {
            finish({ event: 'provider_changed', target });
            return;
          }
          target.status = current.status;
          consider(target);
          inspect(target);
        },
        () => {
          target.status = 'archived';
          consider(target);
        },
      );
    }
  });
}
