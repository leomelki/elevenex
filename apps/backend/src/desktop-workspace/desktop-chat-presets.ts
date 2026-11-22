import { chatCatalog } from './desktop-chat-catalog.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { DEFAULT_AGENT_PROVIDERS, type AgentModelPreset } from '../settings/settings.types.js';
import { record } from './desktop-chat-projection.js';
import { executeChatAction } from './desktop-chat-actions.js';
import type { SessionChatCommandReply } from '@elevenex/shared';

function isPresetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);
}

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
): Promise<SessionChatCommandReply> {
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
  if (
    action.type === 'preset-update' || action.type === 'preset-reorder' ||
    action.type === 'preset-delete' || action.type === 'preset-restore'
  )
    return editSavedPresets(registry, settings, action);
  if (action.expectedProvider !== session.activeAgentProvider)
    throw new ConflictException(
      'The selected harness changed. Refresh this conversation.',
    );
  if (!isPresetId(action.id))
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
  if (action.type === 'preset' && action.expectedMix !== undefined) {
    const expected = record(action.expectedMix);
    settings.assertPresetDefaultRevision(expected.revision);
    if ((raw.selectedModel || null) !== expected.model ||
      (raw.reasoningEffort || null) !== expected.reasoning ||
      (raw.fastMode === true) !== expected.fast)
      throw new ConflictException('This chat’s agent settings changed before the preset could be applied.');
  }
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
    preset = readPreset(action, action.provider === undefined
      ? session.activeAgentProvider
      : action.provider);
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
  validatePresetMix(preset, provider, target);
  if (action.type === 'preset' && action.expectedMix !== undefined)
    settings.assertPresetDefaultRevision(record(action.expectedMix).revision);
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

function readPreset(action: Record<string, unknown>, provider: unknown): AgentModelPreset {
  if (
    !isPresetId(action.id) || !isPresetId(provider) ||
    typeof action.name !== 'string' || !action.name.trim() ||
    action.name.trim().length > 48 ||
    (action.model !== null &&
      (typeof action.model !== 'string' || action.model.length > 1000)) ||
    (action.reasoning !== null &&
      (typeof action.reasoning !== 'string' || action.reasoning.length > 1000)) ||
    typeof action.fast !== 'boolean'
  )
    throw new BadRequestException('Invalid preset configuration.');
  return {
    id: action.id,
    name: action.name.trim(),
    provider,
    model: action.model,
    reasoningEffort: action.reasoning,
    fastMode: action.fast,
    isDefault: false,
  };
}

function validatePresetMix(
  preset: AgentModelPreset,
  provider: ReturnType<AgentRuntimeRegistryService['getProvider']>,
  target: Record<string, unknown>,
): void {
  const model = Array.isArray(target.availableModels)
    ? target.availableModels.map(record).find(
        (model) => model.id === (preset.model ?? target.selectedModel),
      )
    : undefined;
  if (preset.model !== null && !model)
    throw new BadRequestException('This model is no longer available.');
  if (
    preset.reasoningEffort !== null &&
    (typeof provider.setReasoningEffort !== 'function' ||
      !Array.isArray(model?.reasoningEfforts) ||
      !model.reasoningEfforts.includes(preset.reasoningEffort))
  )
    throw new BadRequestException('This thinking level is unavailable for the selected model.');
  if (preset.fastMode &&
    (typeof provider.setFastMode !== 'function' || model?.supportsFastMode !== true))
    throw new BadRequestException('Fast mode is unavailable for this model.');
}

async function editSavedPresets(
  registry: AgentRuntimeRegistryService,
  settings: SettingsService,
  action: Record<string, unknown>,
): Promise<SessionChatCommandReply> {
  const revision = action.expectedRevision;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
    throw new BadRequestException('Invalid saved preset revision.');
  const providers = new Set(registry.listProviders().map((provider) => provider.id));
  if (action.type === 'preset-reorder') {
    const ids: unknown = action.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 24 ||
      !ids.every(isPresetId) || new Set(ids).size !== ids.length)
      throw new BadRequestException('Invalid preset order.');
    settings.editAgentModelPresets(revision, (presets) => {
      const visible = new Map(presets.filter((p) => providers.has(p.provider)).map((p) => [p.id, p]));
      if (ids.length !== visible.size || ids.some((id) => !visible.has(id)))
        throw new BadRequestException('The preset order is incomplete.');
      // Unregistered harnesses retain their slots in the stored catalog.
      const ordered = ids.map((id) => visible.get(id)!);
      let index = 0;
      return {
        presets: presets.map((preset) => visible.has(preset.id) ? ordered[index++] : preset),
        result: undefined,
      };
    });
    return { accepted: true };
  }
  const id = action.id;
  if (!isPresetId(id)) throw new BadRequestException('Invalid preset identity.');
  if (action.type === 'preset-delete') {
    const removed = settings.editAgentModelPresets(revision, (presets, defaultProvider) => {
      const position = presets.findIndex((p) => p.id === id && providers.has(p.provider));
      const preset = presets[position];
      if (!preset) throw new BadRequestException('This preset is no longer available.');
      const remaining = presets.filter((p) => p.id !== id);
      const fallback = preset.isDefault && preset.provider === defaultProvider
        ? remaining.find((candidate) => providers.has(candidate.provider) &&
            DEFAULT_AGENT_PROVIDERS.some((provider) => provider === candidate.provider))
        : undefined;
      return {
        presets: fallback
          ? remaining.map((p) => p.provider === fallback.provider ? { ...p, isDefault: p.id === fallback.id } : p)
          : remaining,
        defaultProvider: DEFAULT_AGENT_PROVIDERS.find((provider) => provider === fallback?.provider),
        clearLegacy: preset.isDefault ? [preset.provider] : [],
        result: position,
      };
    });
    return { accepted: true, presetRemoval: { position: removed.result, revision: removed.revision } };
  }
  const draft = readPreset(action, action.provider);
  if (!providers.has(draft.provider)) throw new BadRequestException('This harness is unavailable.');
  if (action.type === 'preset-restore') {
    const { position, defaultIds } = action;
    const defaultProvider = DEFAULT_AGENT_PROVIDERS.find((provider) => provider === action.defaultProvider);
    if (typeof position !== 'number' || !Number.isInteger(position) ||
      position < 0 || position >= 24 || !defaultProvider ||
      !Array.isArray(defaultIds) || defaultIds.length > 24 ||
      !defaultIds.every(isPresetId) || new Set(defaultIds).size !== defaultIds.length)
      throw new BadRequestException('Invalid preset restoration.');
    settings.editAgentModelPresets(revision, (presets) => {
      if (presets.some((p) => p.id === id) || position > presets.length)
        throw new BadRequestException('This preset cannot be restored.');
      const next = [...presets];
      next.splice(position, 0, draft);
      if (defaultIds.some((defaultId) => !next.some((p) => p.id === defaultId)))
        throw new BadRequestException('Invalid preset defaults.');
      return {
        presets: next.map((p) => ({ ...p, isDefault: defaultIds.includes(p.id) })),
        defaultProvider,
        result: undefined,
      };
    });
    return { accepted: true };
  }
  settings.assertPresetDefaultRevision(revision);
  const original = settings.getAgentModelPresets().find((p) => p.id === id);
  if (!original || !providers.has(original.provider))
    throw new BadRequestException('This preset is no longer available.');
  const providerChanged = original.provider !== draft.provider;
  if (providerChanged || original.model !== draft.model ||
    original.reasoningEffort !== draft.reasoningEffort || !!original.fastMode !== draft.fastMode) {
    const catalog = await chatCatalog(registry, settings, draft.provider);
    if (catalog.error) throw new BadRequestException(catalog.error);
    validatePresetMix(draft, registry.getProvider(draft.provider), {
      availableModels: catalog.models, selectedModel: catalog.model,
    });
  }
  settings.editAgentModelPresets(revision, (presets, defaultProvider) => {
    if (draft.name !== original.name && presets.some(
      (p) => p.id !== id && p.name.toLowerCase() === draft.name.toLowerCase(),
    ))
      throw new BadRequestException('A preset with this name already exists.');
    const newDefaultProvider = providerChanged && original.isDefault && original.provider === defaultProvider
      ? DEFAULT_AGENT_PROVIDERS.find((provider) => provider === draft.provider)
      : undefined;
    return {
      defaultProvider: newDefaultProvider,
      presets: presets.map((p) => {
        if (p.id === id) return { ...draft, isDefault: !!newDefaultProvider || (!providerChanged && !!p.isDefault) };
        if (newDefaultProvider && p.provider === newDefaultProvider && p.isDefault)
          return { ...p, isDefault: false };
        return p;
      }),
      clearLegacy: original.isDefault ? [original.provider] : [],
      result: undefined,
    };
  });
  return { accepted: true };
}
