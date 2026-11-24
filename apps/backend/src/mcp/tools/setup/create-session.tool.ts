import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_AGENT_PROVIDERS } from '../../../settings/settings.types.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
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
    'Launch a cross-harness subagent or create an empty conversation. Prefer native subagents in your own harness. A prompt and stable requestId start work without copying parent history. Same-task delegates share your checkout. Use mode:"async" for background work that should wake you, mode:"wait" to wait briefly on this child, or await_session_event to collect across children.',
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
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Required with prompt. Reuse the same caller/task requestId and inputs after a timeout to recover the original session and delivery state.',
      ),
    mode: z.enum(['async', 'wait']).optional().describe(
      'Same-task delegation only. Async wakes the parent when work settles. Wait briefly returns the child’s result or decision, with a later wake if still outstanding.',
    ),
    timeoutMs: z.number().int().min(1).max(45_000).optional().describe(
      'Mode wait only, up to 45000 ms. A timeout leaves the child running and enables a later wake.',
    ),
    completion: z
      .enum(['wait', 'notify'])
      .optional()
      .describe(
        'Wait (default) leaves collection to await_session_event. Notify queues a completion notice for the caller if it has not collected the result. Requires a first prompt and same-task nested placement.',
      ),
    placement: z
      .enum(['auto', 'task'])
      .optional()
      .describe(
        'Auto nests under an authenticated same-task coding session. Task creates at task level. An explicit folder also requests task-level placement.',
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
    const delegatingSessionId =
      args.placement !== 'task' && args.folderId === undefined
        ? (ctx.agentSessionId ?? undefined)
        : undefined;
    if ((args.mode && args.completion) || (args.timeoutMs !== undefined && args.mode !== 'wait'))
      throw new ToolError({
        code: 'invalid_session_delegation_mode',
        message: 'Pass mode or completion. timeoutMs is only available with mode:"wait".',
      });
    const notifyOnCompletion = args.mode !== undefined || args.completion === 'notify';
    if (notifyOnCompletion && (!args.prompt || delegatingSessionId === undefined))
      throw new ToolError({
        code: 'invalid_session_completion',
        message: 'Completion notices require a first prompt and a same-task coding delegate.',
      });
    const launch = args.requestId
      ? {
          key: hash([ctx.agentSessionId, args.taskId, args.requestId]),
          fingerprint: hash([
            args.name,
            args.provider,
            args.folderId,
            args.placement ?? 'auto',
            args.model,
            args.reasoningEffort,
            args.prompt,
            ...(notifyOnCompletion ? ['notify'] : []),
            ...(args.role && args.role !== 'general' ? [{ role: args.role }] : []),
          ]),
          hasPrompt: !!args.prompt,
          ...(notifyOnCompletion && { notifyOnCompletion }),
        }
      : undefined;
    const prior = launch && sessions.getSessionLaunch(launch);
    const create = async () => {
      const task = await tasks.record(args.taskId);
      if (args.prompt && ctx.agentSessionId !== null)
        assertCanDelegatePrompt(await sessions.findOne(ctx.agentSessionId));
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
        ...(launch && { launch }),
        signal: ctx.signal,
      });
    };
    const session = prior
      ? await sessions.findOne(prior.sessionId)
      : await taskOperation(create);
    const promptStatus =
      launch && args.prompt
        ? await launchSessionPrompt(session, args.prompt, ctx, args.role)
        : undefined;
    const accepted =
      promptStatus === 'accepted' ||
      promptStatus === 'running' ||
      promptStatus === 'queued';
    const observed = args.mode === 'wait' && accepted
      ? await awaitSessionEventTool.handler({
          sessionId: session.id, includeReply: true, timeoutMs: args.timeoutMs ?? 45_000,
        }, ctx)
      : undefined;
    const outcome = observed?.data;
    const timedOut = !!outcome && typeof outcome === 'object' &&
      'event' in outcome && outcome.event === 'timeout';
    let nextStep = observed?.nextStep;
    if (timedOut)
      nextStep = 'Continue independent work. The delegate will wake this session once the result is ready.';
    else if (!nextStep && notifyOnCompletion && accepted)
      nextStep = 'Continue independent work. This session will wake if the result is still outstanding. Use await_session_event(includeReply:true) if you need it now.';
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
        ...(notifyOnCompletion && { completion: 'notify' }),
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
