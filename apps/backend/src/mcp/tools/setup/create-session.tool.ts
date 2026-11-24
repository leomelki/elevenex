import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_AGENT_PROVIDERS } from '../../../settings/settings.types.js';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  assertCanDelegatePrompt,
  sessionPromptNextStep,
} from '../drive/session-prompt-delivery.js';
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
    'Launch a cross-harness subagent or create an empty conversation. Prefer native subagents in your own harness. A prompt and stable requestId start work without copying parent history. Same-task delegates share your checkout. Use completion:"notify" for background work that should wake your conversation when done, or await_session_event to collect results you need now.',
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
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Required with prompt. Reuse the same caller/task requestId and inputs after a timeout to recover the original session and delivery state.',
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
    const notifyOnCompletion = args.completion === 'notify';
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
        ? await launchSessionPrompt(session, args.prompt, ctx)
        : undefined;
    const accepted =
      promptStatus === 'accepted' ||
      promptStatus === 'running' ||
      promptStatus === 'queued';
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
      nextStep: notifyOnCompletion && accepted
        ? 'Continue independent work. A completion notice will follow if you have not collected the result. If the result is needed now, use await_session_event with includeReply:true.'
        : promptStatus
        ? sessionPromptNextStep(
            promptStatus,
            session.id,
            undefined,
            promptStatus === 'queued',
          )
        : 'Use prompt_session to start work. Give it a scoped brief and coordinate writes to the shared worktree.',
    };
  },
});
