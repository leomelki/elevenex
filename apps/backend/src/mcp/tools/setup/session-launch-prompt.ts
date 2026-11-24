import { ToolError, type ToolContext } from '../../tool-registry/tool.types.js';
import { DELEGATED_ASSIGNMENT_CONTEXT } from '../../../sessions/session-agent-message.js';
import {
  assertCanDelegatePrompt,
  sessionMessage,
  startSessionForPrompt,
  submitSessionPrompt,
} from '../drive/session-prompt-delivery.js';

type LaunchStatus =
  | 'not_started'
  | 'acceptance_pending'
  | 'accepted'
  | 'failed'
  | 'running'
  | 'queued';

export async function launchSessionPrompt(
  session: { id: number; status: string; activeAgentProvider: string; delegatedBySessionId?: number | null },
  prompt: string,
  ctx: ToolContext,
): Promise<LaunchStatus> {
  const { sessions, agentRuntime } = ctx.services;
  const receipt = () => sessions.getSessionLaunchDelivery(session.id);
  const existing = receipt();
  if (existing !== 'ready')
    return existing === 'accepted' || existing === 'failed'
      ? existing
      : 'acceptance_pending';

  if (ctx.agentSessionId !== null)
    assertCanDelegatePrompt(await sessions.findOne(ctx.agentSessionId));
  const runtime = agentRuntime.getProvider(session.activeAgentProvider);
  await sessions.assertSessionWorkspaceLinked(session.id);
  ctx.signal.throwIfAborted();

  // An interrupted backend may have reached the harness. Only a delivery
  // still marked ready can be claimed or resumed by a repeated call.
  if (!sessions.claimSessionLaunch(session.id)) {
    const current = receipt();
    return current === 'ready'
      ? 'not_started'
      : current === 'accepted' || current === 'failed'
        ? current
        : 'acceptance_pending';
  }
  let dispatched = false;
  try {
    await startSessionForPrompt(sessions, session);
    ctx.signal.throwIfAborted();
    const brief = session.delegatedBySessionId === ctx.agentSessionId && ctx.agentSessionId !== null
      ? `${DELEGATED_ASSIGNMENT_CONTEXT}\n\n${prompt}`
      : prompt;
    const message = await sessionMessage(brief, ctx, true);
    ctx.signal.throwIfAborted();
    dispatched = true;
    const disposition = await submitSessionPrompt(
      runtime,
      session.id,
      message,
      {
        signal: ctx.signal,
        titlePrompt: prompt,
        queue: true,
        recordDelivery: (delivery) =>
          sessions.recordSessionLaunchDelivery(session.id, delivery),
      },
    );
    return disposition === 'queued'
      ? 'queued'
      : disposition
        ? 'running'
        : 'acceptance_pending';
  } catch (error) {
    if (!dispatched)
      sessions.recordSessionLaunchDelivery(
        session.id,
        ctx.signal.aborted ? 'ready' : 'failed',
      );
    ctx.signal.throwIfAborted();
    throw new ToolError({
      code: 'session_launch_failed',
      message: error instanceof Error ? error.message : String(error),
      details: {
        sessionId: session.id,
        deepLink: ctx.deepLink.session(session.id),
      },
      remediation:
        'Inspect the created session before sending another prompt. Repeating this requestId will only return its receipt.',
    });
  }
}
