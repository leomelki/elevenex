import type { Model } from '@opencode-ai/sdk/v2/client';
import type { AgentProviderModelCatalogPayload } from '../agent-runtime/agent-runtime.types.js';
import type { OpenCodeClient } from './opencode-client.js';

/** Catalogs are location-dependent: project providers must not be replaced by global defaults. */
export async function loadOpenCodeModels(client: OpenCodeClient): Promise<{
  catalog: AgentProviderModelCatalogPayload;
  models: Map<string, Model>;
  providers: { id: string; name: string; connected: boolean }[];
}> {
  // Default-model resolution can materialize custom providers on OpenCode 2.x.
  const config = await client.config.get();
  const providers = await client.provider.list();
  const connected = new Set(providers.data?.connected ?? []);
  const native = new Map<string, Model>();
  const models = (providers.data?.all ?? [])
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models)
        .filter((model) => model.status !== 'deprecated')
        .map((model) => {
          const id = `${provider.id}/${model.id}`;
          native.set(id, model);
          const variants = Object.entries(model.variants ?? {})
            .filter(([, value]) => !value.disabled)
            .map(([key]) => key);
          return {
            id,
            displayName: `${provider.name} · ${model.name}`,
            description: id,
            supportsEffort: variants.length > 0,
            reasoningEfforts: variants,
            supportsFastMode: false,
            isProviderDefault: config.data?.model === id,
          };
        }),
    );
  return {
    models: native,
    catalog: {
      models,
      reasoningEfforts: [
        ...new Set(models.flatMap((model) => model.reasoningEfforts)),
      ],
      providerDefaultModelId: config.data?.model ?? null,
      supportsModelSelection: true,
      unavailableReason: models.length
        ? null
        : 'Connect a provider using OpenCode login or opencode auth login.',
    },
    providers: (providers.data?.all ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: connected.has(provider.id),
    })),
  };
}
