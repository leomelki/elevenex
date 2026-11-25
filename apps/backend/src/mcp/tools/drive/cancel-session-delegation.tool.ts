import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

export const cancelSessionDelegationTool = defineTool({
  name: 'cancel_session_delegation',
  title: 'Cancel delegated session work',
  costClass: 'scoped',
  mutates: true,
  requiresAgent: true,
  disallowSelfTarget: 'session',
  description:
    'Cancel your delegated session’s active and queued work, including its Elevenex descendants. Keeps their conversations and files. Use when replacing or dropping an assignment.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Direct delegate to cancel.'),
  },
  handler: async ({ sessionId }, ctx) => {
    const { session } = await resolveSessionProvider(ctx, sessionId);
    if (
      ctx.agentSessionId === null ||
      session.delegatedBySessionId !== ctx.agentSessionId
    )
      throw new ToolError({
        code: 'not_your_delegate',
        message: 'Cancel a session directly delegated by this conversation.',
      });
    const { sessions, agentRuntime } = ctx.services;
    const handoffs = sessions.delegationHandoffs;
    const release: (() => void)[] = [];
    const pending = [{ id: sessionId, parentId: ctx.agentSessionId, after: 0 }];
    let cancelled = 0;
    const failed: number[] = [];
    try {
      while (pending.length) {
        ctx.signal.throwIfAborted();
        const target = pending[pending.length - 1];
        if (target.after === 0) {
          const { session: child, provider } = await resolveSessionProvider(
            ctx,
            target.id,
          );
          if (child.delegatedBySessionId !== target.parentId) {
            pending.pop();
            continue;
          }
          const finish = handoffs.beginCancellation(child.id);
          if (!finish) {
            failed.push(child.id);
            pending.pop();
            continue;
          }
          release.push(finish);
          handoffs.collected(child.id, target.parentId);
          sessions.cancelReadySessionLaunch(child.id);
          if (child.status !== 'archived') {
            try {
              const runtime = agentRuntime.getProvider(provider);
              await runtime.interrupt(child.id);
              await runtime.clearPendingPrompts(child.id);
              sessions.emit('session-turn-interrupted', {
                sessionId: child.id,
              });
              cancelled++;
            } catch {
              failed.push(child.id);
            }
          }
        }
        const children = handoffs.children(target.id, target.after);
        if (!children.length) {
          pending.pop();
          continue;
        }
        target.after = children[children.length - 1];
        for (const id of children.reverse())
          pending.push({ id, parentId: target.id, after: 0 });
      }
    } finally {
      for (const finish of release) finish();
    }
    if (failed.length)
      throw new ToolError({
        code: 'delegation_cancellation_incomplete',
        message: 'Some delegated sessions could not be stopped.',
        details: {
          sessionId,
          cancelled,
          failedSessionIds: failed.slice(0, 32),
          failedCount: failed.length,
        },
        remediation:
          'Inspect the failed sessions before retrying this cancellation.',
      });
    return {
      data: { sessionId, cancelled },
      deepLink: ctx.deepLink.session(sessionId),
    };
  },
});
