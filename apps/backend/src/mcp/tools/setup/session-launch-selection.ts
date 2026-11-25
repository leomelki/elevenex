import type { SessionAgentSelection } from '../../../database/schema/index.js';
import { ToolError, type ToolContext } from '../../tool-registry/tool.types.js';

/** Reject positively known capability mismatches before creating a conversation. */
export async function resolveLaunchSelection(
  ctx: ToolContext,
  provider: string,
  model: string | undefined,
  reasoningEffort: string | undefined,
): Promise<SessionAgentSelection | undefined> {
  if (model === undefined && reasoningEffort === undefined) return undefined;
  const { agentRuntime } = ctx.services;
  const runtime = agentRuntime.getProvider(provider);
  const [catalog] = await agentRuntime.listModelCatalogs(false, provider);
  const knownModel = catalog.models.find((item) => item.id === model);
  const efforts = knownModel?.reasoningEfforts ?? catalog.reasoningEfforts;
  let problem: string | undefined;
  if (model && !catalog.supportsModelSelection)
    problem = `${provider} does not support model selection.`;
  else if (
    model &&
    (provider === 'opencode' || provider === 'pi') &&
    !/^[^/]+\/.+$/.test(model)
  )
    problem = `${provider} model IDs use provider/model format.`;
  else if (
    reasoningEffort &&
    (typeof runtime.setReasoningEffort !== 'function' ||
      knownModel?.supportsEffort === false ||
      (efforts.length > 0 &&
        (!model || knownModel) &&
        !efforts.includes(reasoningEffort)))
  )
    problem = `${reasoningEffort} is not supported by ${model ?? provider}.`;
  if (problem)
    throw new ToolError({
      code: 'invalid_agent_selection',
      message: problem,
      remediation:
        'Use list_agent_harnesses with the target provider to find its model IDs and reasoning efforts.',
    });
  return { provider, model, reasoningEffort };
}
