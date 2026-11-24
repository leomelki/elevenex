import { BadRequestException } from '@nestjs/common';
import type { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import {
  ANTIGRAVITY_CATALOG_SIGN_IN,
  ANTIGRAVITY_INSTALL,
} from '../antigravity-runtime/antigravity-acp.js';
import type { SettingsService } from '../settings/settings.service.js';

/** Read capabilities without allocating or switching a session runtime. Provider probes own their caches. */
export async function chatCatalog(
  registry: AgentRuntimeRegistryService,
  settings: SettingsService,
  providerId: string,
  refresh = false,
) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId))
    throw new BadRequestException('Invalid harness.');
  const provider = registry.getProvider(providerId);
  const [catalog] = await (refresh
    ? registry.refreshModelCatalogs(providerId)
    : registry.listModelCatalogs(false, providerId));
  if (!catalog) throw new BadRequestException('This harness is unavailable.');
  const reasoningAvailable = typeof provider.setReasoningEffort === 'function';
  const fastAvailable = typeof provider.setFastMode === 'function';
  const models = (
    catalog.supportsModelSelection === false ? [] : catalog.models
  )
    .filter((model) => model.id.length > 0 && model.id.length <= 200)
    .slice(0, 100)
    .map((model) => ({
      id: model.id,
      label: model.displayName.slice(0, 200),
      reasoningEfforts:
        reasoningAvailable && model.supportsEffort !== false
          ? [...new Set(model.reasoningEfforts ?? [])]
              .filter((level) => level.length > 0 && level.length <= 100)
              .slice(0, 20)
          : [],
      supportsFastMode: fastAvailable && model.supportsFastMode === true,
    }));
  const defaults = settings.getAgentProviderDefaults(providerId);
  const model =
    models.find((model) => model.id === defaults.model) ??
    models.find((model) => model.id === catalog.providerDefaultModelId) ??
    models[0];
  const reasoning =
    [defaults.reasoningEffort, catalog.providerDefaultReasoningEffort].find(
      (level) => level && model?.reasoningEfforts.includes(level),
    ) ??
    model?.reasoningEfforts[0] ??
    null;
  const unavailable = catalog.unavailableReason;
  // Only forward known setup messages. CLI failures can contain private data.
  const setupMessage =
    providerId === 'antigravity' &&
    (unavailable === ANTIGRAVITY_INSTALL ||
      unavailable === ANTIGRAVITY_CATALOG_SIGN_IN)
      ? unavailable
      : null;
  return {
    provider: providerId,
    label: catalog.displayName.slice(0, 200),
    models,
    model: model?.id ?? null,
    reasoning,
    fast: model?.supportsFastMode === true && defaults.fastMode === true,
    reasoningAvailable,
    fastAvailable,
    error:
      !models.length && unavailable
        ? (setupMessage ??
          'Could not load this harness’s models. Check its connection and try again.')
        : null,
  };
}
