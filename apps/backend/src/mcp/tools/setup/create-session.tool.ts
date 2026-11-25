import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sessionAgentProvider } from '../../../sessions/session-provider.js';
import { DEFAULT_AGENT_PROVIDERS } from '../../../settings/settings.types.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { sessionMentionIds } from '../drive/session-prompt-context.js';
import {
  assertCanDelegatePrompt,
  assertSessionNotCancelling,
  sessionPromptNextStep,
} from '../drive/session-prompt-delivery.js';
import { awaitSessionEventTool } from '../observe/await-session-event.tool.js';
import { launchSessionPrompt } from './session-launch-prompt.js';
import { resolveLaunchSelection } from './session-launch-selection.js';
import { taskOperation } from './task.util.js';

function hash(fields: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export const createSessionTool = defineTool({
  name: 'create_session',
  title: 'Create task conversation',
  costClass: 'scoped',
  mutates: true,
  currentSessionScope: 'task',
  description:
    'Create a task conversation or launch a subagent. A first prompt in your own task starts a background child that reports back automatically. Use mode:"wait" for a result needed now, or mode:"standalone" for an independent conversation. Prefer native subagents when they meet the request.',
  inputShape: {
    taskId: z
      .number()
      .int()
      .positive()
      .describe(
        'Ready task ID from get_current_session, get_task, or list_tasks. Repo and checkout are resolved from the task.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .optional()
      .describe('Optional conversation name; generated when omitted.'),
    provider: z
      .enum(DEFAULT_AGENT_PROVIDERS)
      .optional()
      .describe(
        'Target harness. Omitted uses the configured Elevenex default. Use list_agent_harnesses to discover choices.',
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Model ID in the target harness. Omitted uses that harness’s configured defaults.',
      ),
    reasoningEffort: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('Reasoning effort or model variant ID in the target harness.'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(32_000)
      .optional()
      .describe(
        'Optional first prompt. Give a self-contained brief with scope, file ownership and expected result.',
      ),
    role: z.enum(['research', 'review', 'design', 'test', 'general']).optional().describe(
      'Optional role to include in the initial brief.',
    ),
    mentionSessionIds: sessionMentionIds,
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Required with prompt. Reuse the same caller/task requestId and inputs after a timeout to recover the original session and delivery state.',
      ),
    mode: z.enum(['standalone', 'async', 'wait']).optional().describe(
      'Standalone creates at task level. Async (default for a first prompt in your own task) wakes the parent. Wait blocks for a child result or decision. Async and wait require a prompt in your own task.',
    ),
    timeoutMs: z.number().int().min(1).max(45_000).optional().describe(
      'Mode wait only, up to 45000 ms. A timeout leaves the child running and enables a later wake.',
    ),
    folderId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional session folder in the same task, from list_session_folders.',
      ),
  },
  handler: async (args, ctx) => {
    const { sessions, tasks } = ctx.services;
    if (args.prompt && !args.requestId)
      throw new ToolError({
        code: 'session_request_id_required',
        message:
          'Starting a session with a prompt requires a stable requestId.',
        remediation:
          'Choose a requestId for this launch and reuse it with the same inputs if the response is lost.',
      });
    const mentions = [...new Set(args.mentionSessionIds ?? [])];
    if (mentions.length && !args.prompt)
      throw new ToolError({
        code: 'session_mention_requires_prompt',
        message: 'Pass a first prompt to attach previous session context.',
      });
    if (args.timeoutMs !== undefined && args.mode !== 'wait')
      throw new ToolError({
        code: 'invalid_session_delegation_mode',
        message: 'timeoutMs is only available with mode:"wait".',
      });
    const caller = ctx.agentSessionId !== null && (args.prompt || (args.mode !== 'standalone' && args.folderId === undefined))
      ? await sessions.findOne(ctx.agentSessionId) : null;
    const delegatingSessionId =
      caller?.surface === 'session' && !caller.isTemporary && caller.workspaceId === args.taskId &&
      args.mode !== 'standalone' && args.folderId === undefined
        ? caller.id : undefined;
    const notifyOnCompletion = !!args.prompt && delegatingSessionId !== undefined;
    if ((args.mode === 'async' || args.mode === 'wait') && !notifyOnCompletion)
      throw new ToolError({
        code: 'invalid_session_completion',
        message: 'Modes async and wait require a first prompt in the caller’s task without a folder. Use standalone for an independent conversation.',
      });
    const launch = args.requestId
      ? {
          key: hash([ctx.agentSessionId, args.taskId, args.requestId]),
          fingerprint: hash([
            args.name,
            args.provider,
            args.folderId,
            args.mode === 'standalone' ? 'task' : 'auto',
            args.model,
            args.reasoningEffort,
            args.prompt,
            ...(notifyOnCompletion ? ['notify'] : []),
            ...(args.role && args.role !== 'general' ? [{ role: args.role }] : []),
            ...(mentions.length ? [mentions] : []),
          ]),
          hasPrompt: !!args.prompt,
          ...(notifyOnCompletion && { notifyOnCompletion }),
        }
      : undefined;
    const prior = launch && sessions.getSessionLaunch(launch);
    const canWakeParent = !caller || sessionAgentProvider(caller) !== 'antigravity';
    const create = async () => {
      const task = await tasks.record(args.taskId);
      if (caller && args.prompt) assertCanDelegatePrompt(caller);
      const provider =
        args.provider ??
        (args.model || args.reasoningEffort
          ? await sessions.resolveInitialAgentProvider(undefined)
          : undefined);
      const agentSelection = provider
        ? await resolveLaunchSelection(
            ctx,
            provider,
            args.model,
            args.reasoningEffort,
          )
        : undefined;
      ctx.signal.throwIfAborted();
      assertSessionNotCancelling(sessions, ctx.agentSessionId);
      return sessions.create({
        repoId: task.repoId,
        workspaceId: task.id,
        name:
          args.name ?? args.prompt?.split(/\r?\n/, 1)[0].trim().slice(0, 96),
        folderId: args.folderId,
        surface: 'session',
        activeAgentProvider: provider,
        ...(delegatingSessionId !== undefined && { delegatingSessionId }),
        ...(agentSelection && { agentSelection }),
        ...(launch && { launch: canWakeParent ? launch : { ...launch, notifyOnCompletion: false } }),
        signal: ctx.signal,
      });
    };
    const session = prior
      ? await sessions.findOne(prior.sessionId)
      : await taskOperation(create);
    // Reserve delivery before submission. A fast child can settle while the
    // harness is still returning the first prompt's acceptance to this call.
    const releaseWait = args.mode === 'wait' && delegatingSessionId !== undefined
      ? sessions.delegationHandoffs?.observe(delegatingSessionId, [session.id])
      : undefined;
    const { promptStatus, accepted, observed } = await (async () => {
      try {
        const promptStatus = launch && args.prompt
          ? await launchSessionPrompt(session, args.prompt, ctx, args.role, mentions)
          : undefined;
        const accepted = promptStatus === 'accepted' || promptStatus === 'running' || promptStatus === 'queued';
        const observed = args.mode === 'wait' && accepted
          ? await awaitSessionEventTool.handler({
              sessionId: session.id, includeReply: true, timeoutMs: args.timeoutMs ?? 45_000,
            }, ctx)
          : undefined;
        return { promptStatus, accepted, observed };
      } finally {
        releaseWait?.();
      }
    })();
    const outcome = observed?.data;
    const timedOut = !!outcome && typeof outcome === 'object' &&
      'event' in outcome && outcome.event === 'timeout';
    let nextStep = observed?.nextStep;
    if (notifyOnCompletion && !canWakeParent && (timedOut || (!observed && accepted)))
      nextStep = 'Use await_session_event to collect this delegate. Antigravity requires a desktop chat send to start a new turn.';
    else if (timedOut || (!nextStep && notifyOnCompletion && accepted))
      nextStep = 'This session wakes when the delegate finishes or needs a decision. Continue independent work and end your turn when none remains. If your next step depends on the result now, use await_session_event.';
    else if (!nextStep && promptStatus)
      nextStep = sessionPromptNextStep(promptStatus, session.id, undefined, promptStatus === 'queued');

    return {
      data: {
        taskId: args.taskId,
        sessionId: session.id,
        name: session.name,
        repoId: session.repoId,
        branch: session.branchName,
        worktreePath: session.worktreePath,
        provider: session.activeAgentProvider,
        status: session.status,
        parentSessionId: session.parentSessionId ?? null,
        delegatedBySessionId: session.delegatedBySessionId ?? null,
        ...(notifyOnCompletion && { completion: canWakeParent ? 'notify' : 'wait' }),
        ...(observed && { result: observed.data }),
        ...(session.agentSelection?.provider ===
          session.activeAgentProvider && {
          model:
            session.activeAgentProvider === 'claude'
              ? session.claudeModelSelection?.model
              : session.agentSelection?.model,
          reasoningEffort: session.agentSelection?.reasoningEffort,
        }),
        ...(promptStatus !== undefined && {
          promptStatus,
          accepted,
        }),
      },
      touched: { sessionId: session.id },
      deepLink: ctx.deepLink.session(session.id),
      nextStep: nextStep ??
        'Use prompt_session to start work. Give it a scoped brief and coordinate writes to the shared worktree.',
    };
  },
});
