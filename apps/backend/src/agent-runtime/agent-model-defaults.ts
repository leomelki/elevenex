import { AGENT_REASONING_EFFORTS } from './agent-runtime.types.js';
import type { AgentCatalogModel } from './agent-runtime.types.js';

/**
 * Sorts thinking levels weakest-first using the well-known order, keeping any
 * provider-specific level we don't recognise at the end rather than dropping
 * it — a provider may ship a new level before this list knows about it.
 */
export function orderReasoningEfforts(efforts: readonly string[]): string[] {
  const known = AGENT_REASONING_EFFORTS as readonly string[];
  const unknown = efforts.filter((effort) => !known.includes(effort)).sort();
  return [...known.filter((effort) => efforts.includes(effort)), ...unknown];
}

export interface AgentStartupSelection {
  selectedModel: string | null;
  reasoningEffort: string | null;
}

export interface AgentConfiguredDefaults {
  model: string | null;
  reasoningEffort: string | null;
}

/**
 * Turns the user's configured per-provider defaults into the model/thinking
 * level a freshly created session starts on.
 *
 * A configured model id is honored even when it isn't in `availableModels`:
 * the catalog can be stale or the model brand new, and the provider — not this
 * cache — is the authority on what it accepts. A configured thinking level is
 * dropped only when the catalog positively says the chosen model can't use it,
 * so a stale catalog never silently downgrades a working setup.
 */
export function resolveAgentStartupSelection(
  defaults: AgentConfiguredDefaults,
  availableModels: readonly AgentCatalogModel[] = [],
  providerDefaultModel: string | null = null,
): AgentStartupSelection {
  const selectedModel = defaults.model ?? providerDefaultModel ?? null;
  const known = selectedModel
    ? availableModels.find((model) => model.id === selectedModel)
    : undefined;

  const effort = defaults.reasoningEffort;
  if (!effort) {
    return { selectedModel, reasoningEffort: null };
  }

  const modelRejectsEffort = known?.supportsEffort === false;
  const supportedEfforts = known?.reasoningEfforts;
  const outsideReportedRange =
    Array.isArray(supportedEfforts) &&
    supportedEfforts.length > 0 &&
    !supportedEfforts.includes(effort);

  return {
    selectedModel,
    reasoningEffort: modelRejectsEffort || outsideReportedRange ? null : effort,
  };
}
