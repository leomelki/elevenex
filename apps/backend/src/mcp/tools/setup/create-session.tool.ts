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
    'Launch a cross-harness subagent in your ready task, or create an empty conversation. Prefer native subagents for work in your own harness. Set provider, model and reasoningEffort as needed. A prompt plus a stable requestId starts one turn with only that brief. Same-task creations are nested under the caller by default and share its files. Use create_task for isolated work.',
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
          ]),
          hasPrompt: !!args.prompt,
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
          accepted:
            promptStatus === 'accepted' ||
            promptStatus === 'running' ||
            promptStatus === 'queued',
        }),
      },
      touched: { sessionId: session.id },
      deepLink: ctx.deepLink.session(session.id),
      nextStep: promptStatus
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
