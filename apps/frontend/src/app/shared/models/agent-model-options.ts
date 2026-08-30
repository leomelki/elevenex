import type { OptionSelectItem } from '@/shared/components/option-select';
import type { AgentProviderModelCatalog } from './agent-model-catalog.model';
import type { ClaudeModelOption } from './claude-runtime.model';

/**
 * Turns a provider's reported catalog into picker options. Shared so every
 * place that lets a model be chosen ahead of a session — the per-provider
 * defaults, the dictation cleanup model — offers the same list, the same
 * "Agent default" entry, and the same handling of a saved-but-unlisted id.
 */

/** The "no explicit choice" entry; empty value, matching `OptionSelectItem`. */
export const AGENT_DEFAULT_OPTION: OptionSelectItem = {
  value: '',
  label: 'Agent default',
  description: 'Whatever the agent picks on its own',
};

/**
 * Keeps a saved selection visible even when the catalog no longer advertises
 * it — a renamed model, a provider that's temporarily unreachable, or an id
 * typed in before this build knew about it. Dropping it from the list would
 * misrepresent the setting as unset while it is still in force.
 */
export function withPinnedModel(
  models: ClaudeModelOption[],
  selectedModel: string,
): ClaudeModelOption[] {
  if (!selectedModel || models.some((model) => model.id === selectedModel)) {
    return models;
  }

  return [
    ...models,
    {
      id: selectedModel,
      displayName: selectedModel,
      description: 'Saved earlier; this agent is not offering it right now.',
    },
  ];
}

export function toModelOption(
  model: ClaudeModelOption,
  catalog: AgentProviderModelCatalog | null,
): OptionSelectItem {
  const isProviderDefault =
    model.isProviderDefault === true ||
    (!!catalog?.providerDefaultModelId &&
      model.id === catalog.providerDefaultModelId);

  return {
    value: model.id,
    label: model.displayName || model.id,
    description: model.description || undefined,
    badge: isProviderDefault ? 'Default' : undefined,
  };
}

/** `AGENT_DEFAULT_OPTION` followed by the catalog's models, pin included. */
export function agentModelOptions(
  catalog: AgentProviderModelCatalog | null,
  selectedModel: string,
): OptionSelectItem[] {
  return [
    AGENT_DEFAULT_OPTION,
    ...withPinnedModel(catalog?.models ?? [], selectedModel).map((model) =>
      toModelOption(model, catalog),
    ),
  ];
}
