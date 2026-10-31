import { chatCatalog } from './desktop-chat-catalog.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { AgentModelPreset } from '../settings/settings.types.js';
import { record } from './desktop-chat-projection.js';
import { executeChatAction } from './desktop-chat-actions.js';

export function chatPresets(
  settings: SettingsService,
  registry: AgentRuntimeRegistryService,
) {
  const providers = registry.listProviders();
  return settings
    .getAgentModelPresets()
    .filter((preset) => providers.some((p) => p.id === preset.provider))
    .map((preset) => ({
      id: preset.id,
      name: preset.name,
      provider: preset.provider,
      providerLabel: providers.find((p) => p.id === preset.provider)!
        .displayName,
      model: preset.model,
      modelLabel: preset.model || 'Provider default',
      reasoning: preset.reasoningEffort,
      fast: preset.fastMode ?? false,
    }));
}

/** Validate the entire mix before changing a session; only an unstarted session can apply it. */
export async function executePresetAction(
  sessions: SessionsService,
  registry: AgentRuntimeRegistryService,
  settings: SettingsService,
  sessionId: number,
  session: Awaited<ReturnType<SessionsService['findOne']>>,
  action: Record<string, unknown>,
) {
  await sessions.assertSessionWorkspaceLinked(sessionId);
  if (action.type === 'preset-default-restore') {
    if (
      session.status === 'archived' ||
      session.workspaceArchivedAt ||
      typeof action.provider !== 'string' ||
      !Array.isArray(action.defaultIds) ||
      action.defaultIds.length > 24 ||
      !action.defaultIds.every((id): id is string => typeof id === 'string') ||
      typeof action.expectedRevision !== 'string'
    )
      throw new BadRequestException('Invalid default restoration.');
    settings.restoreAgentPresetDefault(
      { provider: action.provider, defaultIds: action.defaultIds },
      action.expectedRevision,
    );
    return { accepted: true };
  }
  if (
    session.status === 'archived' ||
    session.workspaceArchivedAt ||
    sessions.hasStartedAgentRuntime(session)
  )
    throw new BadRequestException(
      'Presets can only be chosen before the first message.',
    );
  if (action.expectedProvider !== session.activeAgentProvider)
    throw new ConflictException(
      'The selected harness changed. Refresh this conversation.',
    );
  if (
    typeof action.id !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(action.id)
  )
    throw new BadRequestException('Invalid preset identity.');
  const current = registry.getProvider(session.activeAgentProvider);
  const raw = record(
    await current.getRuntimeState(sessionId, { initialize: false }),
  );
  if (
    raw.canInterrupt ||
    raw.runPhase === 'running' ||
    raw.runPhase === 'waiting' ||
    raw.pendingPermissionRequest ||
    raw.pendingUserInputRequest ||
    (Array.isArray(raw.pendingPrompts) && raw.pendingPrompts.length)
  )
    throw new ConflictException('Wait for the current operation to finish.');
  const makeDefault =
    action.type === 'preset-default' ||
    (action.type === 'save-preset' && action.makeDefault === true);
  if (
    action.makeDefault !== undefined &&
    typeof action.makeDefault !== 'boolean'
  )
    throw new BadRequestException('Invalid preset default option.');
  const expectedRevision =
    action.type === 'preset-default'
      ? action.expectedRevision
      : action.expectedDefaultRevision;
  if (makeDefault) settings.assertPresetDefaultRevision(expectedRevision);
  let preset: AgentModelPreset;
  if (action.type === 'save-preset') {
    if (
      typeof action.name !== 'string' ||
      !action.name.trim() ||
      action.name.trim().length > 48 ||
      (action.model !== null &&
        (typeof action.model !== 'string' || action.model.length > 1000)) ||
      (action.reasoning !== null &&
        (typeof action.reasoning !== 'string' ||
          action.reasoning.length > 1000)) ||
      typeof action.fast !== 'boolean'
    )
      throw new BadRequestException('Invalid preset configuration.');
    preset = {
      id: action.id,
      name: action.name.trim(),
      provider:
        action.provider === undefined
          ? session.activeAgentProvider
          : typeof action.provider === 'string'
            ? action.provider
            : '',
      model: action.model,
      reasoningEffort: action.reasoning,
      fastMode: action.fast,
      isDefault: false,
    };
  } else {
    const found = settings
      .getAgentModelPresets()
      .find((preset) => preset.id === action.id);
    if (!found)
      throw new BadRequestException('This preset is no longer available.');
    preset = found;
  }
  const provider = registry.getProvider(preset.provider);
  const catalog =
    action.type === 'save-preset' && action.provider !== undefined
      ? await chatCatalog(registry, settings, preset.provider)
      : null;
  if (catalog?.error) throw new BadRequestException(catalog.error);
  const target = catalog
    ? { availableModels: catalog.models, selectedModel: catalog.model }
    : preset.provider === session.activeAgentProvider
      ? raw
      : record(
          await provider.getRuntimeState(sessionId, { initialize: false }),
        );
  const model = Array.isArray(target.availableModels)
    ? target.availableModels
        .map(record)
        .find((model) => model.id === (preset.model ?? target.selectedModel))
    : undefined;
  if (preset.model !== null && !model)
    throw new BadRequestException(
      'This model is no longer available. Adjust the agent and save a new preset.',
    );
  if (
    preset.reasoningEffort !== null &&
    (typeof provider.setReasoningEffort !== 'function' ||
      !Array.isArray(model?.reasoningEfforts) ||
      !model.reasoningEfforts.includes(preset.reasoningEffort))
  )
    throw new BadRequestException(
      'This thinking level is unavailable for the selected model.',
    );
  if (
    preset.fastMode &&
    (typeof provider.setFastMode !== 'function' ||
      model?.supportsFastMode !== true)
  )
    throw new BadRequestException('Fast mode is unavailable for this model.');
  let defaultChange =
    action.type === 'save-preset'
      ? makeDefault
        ? settings.addAgentModelPreset(
            preset,
            true,
            typeof expectedRevision === 'string' ? expectedRevision : undefined,
          )
        : settings.addAgentModelPreset(preset)
      : undefined;
  if (action.type === 'preset-default' && typeof expectedRevision === 'string')
    defaultChange = settings.setAgentPresetDefault(preset.id, expectedRevision);
  try {
    if (preset.provider !== session.activeAgentProvider)
      await executeChatAction(sessions, registry, sessionId, session, {
        type: 'provider',
        provider: preset.provider,
        expectedProvider: session.activeAgentProvider,
      });
    await provider.setSelectedModel(sessionId, preset.model);
    if (provider.setReasoningEffort)
      await provider.setReasoningEffort(sessionId, preset.reasoningEffort);
    if (provider.setFastMode)
      await provider.setFastMode(sessionId, preset.fastMode ?? false);
  } catch {
    // A provider may have accepted some settings. Reconcile; never replay this sequence.
    throw new ConflictException(
      'The agent configuration could not be fully applied. Check the current agent before sending. Your saved presets are retained.',
    );
  }
  return { accepted: true, ...(defaultChange ? { defaultChange } : {}) };
}
