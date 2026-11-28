import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';

export const listAgentHarnessesTool = defineTool({
  name: 'list_agent_harnesses',
  title: 'List agent harnesses and models',
  costClass: 'cached',
  description:
    'List available harnesses and native subagent support. Pass provider to look up model IDs and reasoning efforts for create_session.',
  annotations: { readOnlyHint: true },
  inputShape: {
    provider: z.string().trim().min(1).max(64).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  },
  handler: async (args, ctx) => {
    const { agentRuntime } = ctx.services;
    if (!args.provider)
      return {
        data: {
          harnesses: agentRuntime.listProviders().map((info) => ({
            provider: info.id,
            name: info.displayName,
            nativeSubagents: info.capabilities.subagents,
          })),
        },
        nextStep:
          'Use native subagents when they support the requested settings. Pass a provider here for its models, then use create_session for cross-harness work.',
      };
    const [catalog] = await agentRuntime.listModelCatalogs(
      false,
      args.provider,
    );
    ctx.signal.throwIfAborted();
    const models = catalog.models.slice(args.offset, args.offset + args.limit);
    const nextOffset =
      args.offset + models.length < catalog.models.length
        ? args.offset + models.length
        : null;
    return {
      data: {
        provider: catalog.provider,
        providerDefaultModelId: catalog.providerDefaultModelId,
        supportsModelSelection: catalog.supportsModelSelection,
        reasoningEfforts: catalog.reasoningEfforts,
        unavailableReason: catalog.unavailableReason ?? null,
        nextOffset,
        models: models.map((model) => ({
          id: model.id,
          name: model.displayName,
          reasoningEfforts: model.reasoningEfforts,
        })),
      },
      truncated: nextOffset !== null,
    };
  },
});
