import { z } from 'zod';
import type { AgentProviderModelCatalogPayload } from '../../../agent-runtime/agent-runtime.types.js';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from '../drive/provider.util.js';

export const getSessionConfigTool = defineTool({
  name: 'get_session_config',
  title: 'Session configuration',
  costClass: 'cached',
  currentSessionScope: 'session',
  annotations: { readOnlyHint: true },
  description:
    'Discover a conversation’s selected model, provider default, available model IDs, reasoning levels and runtime capabilities before reconfiguring it. Does not start an agent or return transcripts, credentials or runtime history. Model lists are paged.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe(
        'Conversation to inspect. Defaults to your own coding session.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Model page offset; default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Model handles per page, 1-100; default 25.'),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProvider(provider);
    const [state, catalog] = await Promise.all([
      runtime.getRuntimeState(args.sessionId),
      typeof runtime.getModelCatalog === 'function'
        ? runtime.getModelCatalog()
        : Promise.resolve(null),
    ]);
    const selected = state as typeof state & {
      selectedModel?: string | null;
      permissionMode?: string | null;
      planMode?: boolean;
      availableModels?: AgentProviderModelCatalogPayload['models'];
    };
    const models = catalog?.models ?? selected.availableModels ?? [];
    const page = models.slice(args.offset, args.offset + args.limit);
    const nextOffset =
      args.offset + page.length < models.length
        ? args.offset + page.length
        : null;
    return {
      data: {
        sessionId: args.sessionId,
        provider,
        model: selected.selectedModel ?? null,
        providerDefaultModelId: catalog?.providerDefaultModelId ?? null,
        supportsModelSelection: catalog?.supportsModelSelection ?? true,
        permissionMode: selected.permissionMode ?? null,
        supportsPermissionMode: typeof runtime.setPermissionMode === 'function',
        permissionModes:
          typeof runtime.setPermissionMode === 'function'
            ? (runtime.info.permissionModes ?? [])
            : [],
        planMode: selected.planMode ?? false,
        reasoningEffort: state.reasoningEffort ?? null,
        reasoningEfforts: catalog?.reasoningEfforts ?? [],
        capabilities: runtime.info.capabilities,
        totalModels: models.length,
        nextOffset,
        models: page.map((model) => ({
          id: model.id,
          name: model.displayName,
          reasoningEfforts: model.reasoningEfforts,
        })),
        unavailableReason: catalog?.unavailableReason ?? null,
      },
      truncated: nextOffset !== null,
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep:
        'set_model selects a returned model ID; null restores the default. set_permission_mode uses a supported mode. Configuration changes do not start work.',
    };
  },
});
